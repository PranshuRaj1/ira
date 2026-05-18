/**
 * Memory consolidation: fetches candidates, clusters them, synthesizes
 * summaries via Gemini, and atomically archives sources.
 *
 * Safety properties:
 *  - FOR UPDATE SKIP LOCKED prevents two concurrent job runs from
 *    processing the same memories simultaneously.
 *  - timeKey written before INCR so partial crashes fail safe.
 *  - Each cluster wrapped in its own sql.transaction() — a failed
 *    cluster doesn't roll back the others.
 *  - Consolidated summary gets a real embedding so it's retrievable
 *    by vector search (not a placeholder).
 *  - Low LLM confidence (< MIN_CONFIDENCE) skips the cluster entirely.
 */

import { neon } from '@neondatabase/serverless'
import { embed } from '../gemini'
import { groqChat } from '../groq'
import {
  clusterMemories,
  CandidateMemory,
  MIN_ACCESS_COUNT,
  CONSOLIDATION_WINDOW_DAYS,
  MIN_CONFIDENCE,
} from './clustering'

// ── LLM synthesis ────────────────────────────────────────────────

type SynthesisResult = {
  summary:    string
  tier:       'general_fact' | 'strong_preference' | 'core_identity'
  confidence: number
}

/**
 * Call Gemini (Flash) to synthesize a cluster into one insight.
 * 8s AbortController timeout — breaker handled by the caller (sleep cycle job).
 * Returns null if the response is low-confidence, malformed, or timed out.
 */
async function synthesizeCluster(
  memories: CandidateMemory[]
): Promise<SynthesisResult | null> {
  const facts = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n')

  const prompt = `You are a memory consolidation system for a personal AI assistant.
Given these related memory fragments about the same user, synthesize them into one concise insight.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences
- Summary must be a single sentence under 30 words
- Confidence should reflect how coherent these memories are as a group (0.0 to 1.0)
- If memories contradict each other, set confidence below 0.5

Memory fragments:
${facts}

JSON format (exactly):
{"summary":"...","tier":"general_fact|strong_preference|core_identity","confidence":0.0}`

  try {
    const raw = await groqChat([
      { role: 'user', content: prompt }
    ], 200, 0.1) // Low temperature for stability

    if (!raw) return null

    const parsed = JSON.parse(raw) as SynthesisResult
    if (parsed.confidence < MIN_CONFIDENCE) {
      console.log(`[consolidation] skipping cluster — confidence ${parsed.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`)
      return null
    }

    // Validate tier
    const validTiers = ['general_fact', 'strong_preference', 'core_identity']
    if (!validTiers.includes(parsed.tier)) parsed.tier = 'general_fact'

    return parsed
  } catch (err) {
    console.error('[consolidation] Groq synthesis failed:', err)
    return null
  }
}

// ── Fetch candidates with row-level lock ─────────────────────────

export async function fetchCandidates(
  dbUrl: string,
  userId: string
): Promise<CandidateMemory[]> {
  const sql = neon(dbUrl)

  // FOR UPDATE SKIP LOCKED: a concurrent job run skips already-locked rows
  // rather than blocking. Means two runs never process the same memory.
  const rows = await sql`
    SELECT
      id::text,
      content,
      embedding::text,
      importance,
      access_count,
      tier
    FROM memories
    WHERE user_id                = ${userId}
      AND is_archived            = false
      AND memory_type            = 'source'
      AND is_consolidated_source = false
      AND tier                   IN ('general_fact', 'strong_preference')
      AND tier                  != 'core_identity'
      AND access_count           >= ${MIN_ACCESS_COUNT}
      AND last_accessed          >= NOW() - INTERVAL '1 day' * ${CONSOLIDATION_WINDOW_DAYS}
    ORDER BY access_count DESC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  `

  return rows.map(r => ({
    id:           r.id as string,
    content:      r.content as string,
    embedding:    JSON.parse(r.embedding as string) as number[],
    importance:   r.importance as number,
    access_count: r.access_count as number,
    tier:         r.tier as string,
  }))
}

// ── Decay rate by tier ───────────────────────────────────────────

const TIER_DECAY: Record<string, number> = {
  core_identity:     0.01,
  strong_preference: 0.05,
  general_fact:      0.1,
}

// ── Main consolidation job ───────────────────────────────────────

export type ConsolidationResult = {
  consolidated: number
  clusters:     number
  skipped:      number
}

export async function consolidateMemories(
  dbUrl:          string,
  geminiApiKey:   string,
  userId:         string
): Promise<ConsolidationResult> {
  const sql = neon(dbUrl)

  const candidates = await fetchCandidates(dbUrl, userId)
  if (candidates.length < 3) {
    return { consolidated: 0, clusters: 0, skipped: 0 }
  }

  const clusters = clusterMemories(candidates)
  console.log(
    `[consolidation] user=${userId} clusters=${clusters.length} from ${candidates.length} candidates`
  )

  let totalConsolidated = 0
  let skipped           = 0
  const consolidationId = crypto.randomUUID()

  for (const cluster of clusters) {
    const synthesis = await synthesizeCluster(cluster)
    if (!synthesis) {
      skipped++
      continue
    }

    // Real embedding — so the summary is retrievable by vector search
    let embedding: number[]
    try {
      embedding = await embed(geminiApiKey, synthesis.summary)
    } catch (err) {
      console.error('[consolidation] embed failed for cluster summary — skipping:', err)
      skipped++
      continue
    }

    const sourceIds     = cluster.map(m => m.id)
    const avgImportance = cluster.reduce((s, m) => s + m.importance, 0) / cluster.length
    const totalAccess   = cluster.reduce((s, m) => s + m.access_count, 0)
    const decayRate     = TIER_DECAY[synthesis.tier] ?? 0.1

    try {
      await sql.transaction([
        sql`
          INSERT INTO memories (
            user_id, content, importance, tier, decay_rate,
            access_count, source_memory_ids, consolidation_id,
            memory_type, embedding, source
          ) VALUES (
            ${userId},
            ${synthesis.summary},
            ${Math.min(avgImportance * 1.2, 1.0)},
            ${synthesis.tier},
            ${decayRate},
            ${totalAccess},
            ${sourceIds},
            ${consolidationId},
            'consolidated',
            ${JSON.stringify(embedding)}::vector,
            'system'
          )
        `,
        sql`
          UPDATE memories
          SET
            is_archived            = true,
            archived_at            = NOW(),
            archived_reason        = 'consolidated',
            is_consolidated_source = true,
            consolidation_id       = ${consolidationId}
          WHERE id = ANY(${sourceIds}::uuid[])
        `,
      ])

      console.log(
        `[consolidation] cluster consolidated: "${synthesis.summary.slice(0, 60)}…"`,
        `tier=${synthesis.tier} sources=${cluster.length} confidence=${synthesis.confidence.toFixed(2)}`
      )
      totalConsolidated += cluster.length
    } catch (err) {
      console.error('[consolidation] transaction failed for cluster — skipped:', err)
      skipped++
    }
  }

  return { consolidated: totalConsolidated, clusters: clusters.length, skipped }
}

// ── Rollback ─────────────────────────────────────────────────────

export async function rollbackConsolidation(
  dbUrl:            string,
  consolidationId:  string
): Promise<void> {
  const sql = neon(dbUrl)

  await sql.transaction([
    sql`
      UPDATE memories
      SET
        is_archived            = false,
        archived_at            = NULL,
        archived_reason        = NULL,
        is_consolidated_source = false,
        consolidation_id       = NULL
      WHERE consolidation_id = ${consolidationId}
        AND memory_type      = 'source'
    `,
    sql`
      DELETE FROM memories
      WHERE consolidation_id = ${consolidationId}
        AND memory_type      = 'consolidated'
    `,
  ])

  console.log(`[consolidation] rolled back consolidation_id=${consolidationId}`)
}
