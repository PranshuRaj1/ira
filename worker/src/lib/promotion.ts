/**
 * Deferred memory promotion — runs inside the sleep cycle job,
 * NOT inline on every retrieval (avoids write amplification on hot path).
 *
 * Thresholds are absolute counts with minimum age requirements.
 * Decay rate is reset on promotion — this also handles the demotion
 * concern: a promoted memory that stops being accessed will decay
 * faster if its new tier has a lower decay floor, naturally returning
 * to the effective importance of a lower tier over time.
 */

import { neon } from '@neondatabase/serverless'

const PROMOTION_RULES = [
  {
    from:            'general_fact'    as const,
    to:              'strong_preference' as const,
    minAccessCount:  20,
    minAgeDays:      30,
    newDecayRate:    0.05,
    reason:          'threshold: 20 accesses over 30 days',
  },
  {
    from:            'strong_preference' as const,
    to:              'core_identity'   as const,
    minAccessCount:  50,
    minAgeDays:      90,
    newDecayRate:    0.01,
    reason:          'threshold: 50 accesses over 90 days',
  },
] as const

export async function promoteMemories(
  dbUrl:  string,
  userId: string
): Promise<number> {
  const sql = neon(dbUrl)
  let promoted = 0

  for (const rule of PROMOTION_RULES) {
    const candidates = await sql`
      SELECT id, tier, access_count
      FROM memories
      WHERE user_id      = ${userId}
        AND tier         = ${rule.from}
        AND is_archived  = false
        AND memory_type  = 'source'
        AND access_count >= ${rule.minAccessCount}
        AND created_at   <= NOW() - INTERVAL '1 day' * ${rule.minAgeDays}
    `

    for (const memory of candidates) {
      try {
        await sql.transaction([
          sql`
            UPDATE memories
            SET
              tier       = ${rule.to},
              decay_rate = ${rule.newDecayRate},
              last_accessed = NOW()
            WHERE id = ${memory.id}
          `,
          sql`
            INSERT INTO memory_promotions
              (memory_id, user_id, from_tier, to_tier, access_count, reason)
            VALUES
              (${memory.id}, ${userId}, ${rule.from}, ${rule.to},
               ${memory.access_count}, ${rule.reason})
          `,
        ])

        console.log(
          `[promotion] ${rule.from} → ${rule.to}`,
          `memory=${memory.id} access_count=${memory.access_count}`
        )
        promoted++
      } catch (err) {
        console.error(`[promotion] failed for memory ${memory.id}:`, err)
      }
    }
  }

  return promoted
}
