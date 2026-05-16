import { neon } from '@neondatabase/serverless'
import { resolveContradictions } from './contradiction'
import { ImportanceTier, TIER_CONFIG } from '../types'
import { DECAY_SCORE_EXPR, DECAY_THRESHOLD } from '../lib/decay'

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
  isArchived?: boolean
  archivedAt?: Date
  archivedReason?: string
  decayScoreAtArchive?: number
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
  tier: ImportanceTier = 'general_fact',
  tags: string[] = []
): Promise<void> {
  const sql = neon(dbUrl)
  const config = TIER_CONFIG[tier]
  await sql`
    INSERT INTO memories (user_id, content, embedding, tags, importance, decay_rate, tier)
    VALUES (
      ${userId},
      ${content},
      ${JSON.stringify(embedding)}::vector,
      ${tags},
      ${config.importance},
      ${config.decayRate},
      ${tier}
    )
  `
}

/**
 * Always fetch the user's core_identity memories (name, age, location, etc)
 * directly by tier — bypasses vector similarity competition entirely.
 * These are pinned into every prompt regardless of the current query.
 */
export async function getPinnedIdentityMemories(
  dbUrl: string,
  userId: string
): Promise<Memory[]> {
  const sql = neon(dbUrl)
  const rows = await sql`
    SELECT
      id, user_id, content, importance, access_count,
      last_accessed, created_at, decay_rate, tags,
      ${sql.unsafe(DECAY_SCORE_EXPR())} AS decayed_importance
    FROM memories
    WHERE user_id = ${userId}
      AND tier = 'core_identity'
      AND is_archived = false
    ORDER BY decayed_importance DESC
    LIMIT 5
  `
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
        last_accessed, created_at, decay_rate, tags, tier,
        ${sql.unsafe(DECAY_SCORE_EXPR())} AS decayed_importance,
        (1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector)) AS similarity
      FROM memories
      WHERE user_id = ${userId}
      AND is_archived = false
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 50
    )
    SELECT *
    FROM candidates
    WHERE decayed_importance > ${DECAY_THRESHOLD}
    ORDER BY (
      similarity * decayed_importance *
      (CASE WHEN tier = 'core_identity' THEN 2.0 ELSE 1.0 END)
    ) DESC
    LIMIT ${limit}
  `

  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    await sql`
      UPDATE memories
      SET last_accessed = NOW(), access_count = access_count + 1
      WHERE id = ANY(${ids})
        AND is_archived = false
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
    isArchived: r.is_archived,
  }))
}

export async function deepRecallMemories(
  dbUrl: string,
  userId: string,
  queryEmbedding: number[],
  limit = 5
): Promise<Memory[]> {
  const sql = neon(dbUrl)
  const rows = await sql`
    SELECT
      id, user_id, content, importance, access_count,
      last_accessed, created_at, decay_rate, tags,
      decay_score_at_archive,
      archived_at,
      is_archived,
      archived_reason
    FROM memories
    WHERE user_id = ${userId}
      AND is_archived = true
      AND archived_reason = 'decay'
    ORDER BY (1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector)) DESC
    LIMIT ${limit}
  `

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
    isArchived: r.is_archived,
    archivedAt: r.archived_at ? new Date(r.archived_at) : undefined,
    archivedReason: r.archived_reason,
    decayScoreAtArchive: r.decay_score_at_archive,
  }))
}

export async function resurface(dbUrl: string, memoryId: string): Promise<void> {
  const sql = neon(dbUrl)
  await sql`
    UPDATE memories
    SET
      is_archived  = false,
      archived_at  = NULL,
      archived_reason = NULL,
      decay_score_at_archive = NULL,
      importance   = LEAST(importance * 2, 1.0),
      last_accessed = NOW(),
      access_count = access_count + 1
    WHERE id = ${memoryId}
  `
}

export async function pruneDecayedMemories(
  dbUrl: string,
  userId: string,
  threshold = DECAY_THRESHOLD
): Promise<void> {
  const sql = neon(dbUrl)
  await sql`
    UPDATE memories
    SET
      is_archived            = true,
      archived_at            = NOW(),
      archived_reason        = 'decay',
      decay_score_at_archive = (${sql.unsafe(DECAY_SCORE_EXPR())})
    WHERE user_id = ${userId}
      AND is_archived = false
      AND ${sql.unsafe(DECAY_SCORE_EXPR())} < ${threshold}
  `
}

export async function saveMemoryWithContradictionCheck(
  dbUrl: string,
  userId: string,
  content: string,
  embedding: number[],
  tier: ImportanceTier = 'general_fact',
  tags: string[] = []
): Promise<void> {
  const sql = neon(dbUrl)
  const config = TIER_CONFIG[tier]

  await sql`
    INSERT INTO memories (user_id, content, embedding, tags, importance, decay_rate, tier)
    VALUES (
      ${userId},
      ${content},
      ${JSON.stringify(embedding)}::vector,
      ${tags},
      ${config.importance},
      ${config.decayRate},
      ${tier}
    )
  `

  const similar = await sql`
    SELECT id, content, importance, decay_rate, tier
    FROM memories
    WHERE user_id = ${userId}
    AND is_archived = false
    AND content != ${content}
    AND embedding <=> ${JSON.stringify(embedding)}::vector < 0.15
    LIMIT 5
  `

  if (similar.length > 0) {
    await resolveContradictions(
      dbUrl,
      userId,
      content,
      tier,
      similar.map(r => ({ id: r.id, content: r.content, importance: r.importance, tier: r.tier }))
    )
  }

  await pruneDecayedMemories(dbUrl, userId)
}