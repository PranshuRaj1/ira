import { neon } from '@neondatabase/serverless'
import { resolveContradictions } from './contradiction'

export type Memory = {
  id: string
  userId: string
  content: string
  importance: number
  accessCount: number
  lastAccessed: Date
  createdAt: Date
  decayRate: number
  tags: string[]
}

export async function upsertUser(
  dbUrl: string,
  userId: string,
  platform = 'telegram'
): Promise<void> {
  const sql = neon(dbUrl)
  await sql`
    INSERT INTO users (id, platform, last_active_at)
    VALUES (${userId}, ${platform}, NOW())
    ON CONFLICT (id) DO UPDATE SET last_active_at = NOW()
  `
}

export async function saveMemory(
  dbUrl: string,
  userId: string,
  content: string,
  embedding: number[],
  tags: string[] = []
): Promise<void> {
  const sql = neon(dbUrl)
  await sql`
    INSERT INTO memories (user_id, content, embedding, tags)
    VALUES (
      ${userId},
      ${content},
      ${JSON.stringify(embedding)}::vector,
      ${tags}
    )
  `
}

export async function getRelevantMemories(
  dbUrl: string,
  userId: string,
  queryEmbedding: number[],
  limit = 5
): Promise<Memory[]> {
  const sql = neon(dbUrl)
  const rows = await sql`
    WITH candidates AS (
      SELECT
        id, user_id, content, importance, access_count,
        last_accessed, created_at, decay_rate, tags,
        importance * EXP(
          -decay_rate *
          EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400.0
        ) AS decayed_importance,
        (1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector)) AS similarity
      FROM memories
      WHERE user_id = ${userId}
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 50
    )
    SELECT *
    FROM candidates
    WHERE decayed_importance > 0.05
    ORDER BY (similarity * decayed_importance) DESC
    LIMIT ${limit}
  `

  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    await sql`
      UPDATE memories
      SET last_accessed = NOW(), access_count = access_count + 1
      WHERE id = ANY(${ids})
    `
  }

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    importance: r.importance,
    accessCount: r.access_count,
    lastAccessed: new Date(r.last_accessed),
    createdAt: new Date(r.created_at),
    decayRate: r.decay_rate,
    tags: r.tags ?? [],
  }))
}

export async function pruneDecayedMemories(
  dbUrl: string,
  userId: string,
  threshold = 0.05
): Promise<void> {
  const sql = neon(dbUrl)
  await sql`
    DELETE FROM memories
    WHERE user_id = ${userId}
    AND importance * EXP(
      -decay_rate * EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400
    ) < ${threshold}
  `
}

export async function saveMemoryWithContradictionCheck(
  dbUrl: string,
  userId: string,
  content: string,
  embedding: number[],
  tags: string[] = []
): Promise<void> {
  const sql = neon(dbUrl)

  await sql`
    INSERT INTO memories (user_id, content, embedding, tags)
    VALUES (
      ${userId},
      ${content},
      ${JSON.stringify(embedding)}::vector,
      ${tags}
    )
  `

  const similar = await sql`
    SELECT id, content
    FROM memories
    WHERE user_id = ${userId}
    AND content != ${content}
    AND embedding <=> ${JSON.stringify(embedding)}::vector < 0.15
    LIMIT 5
  `

  if (similar.length > 0) {
    await resolveContradictions(
      dbUrl,
      userId,
      content,
      similar.map(r => ({ id: r.id, content: r.content }))
    )
  }

  await pruneDecayedMemories(dbUrl, userId)
}