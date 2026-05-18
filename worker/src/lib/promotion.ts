import { neon } from '@neondatabase/serverless'

const IDENTITY_PATTERNS = [
  /\bname is\b/i,
  /\bcalled\b/i,
  /\blives in\b/i,
  /\bhometown is\b/i,
  /\bborn in\b/i,
  /\bage is\b/i,
  /\byears old\b/i
]

function isCoreIdentityContent(content: string): boolean {
  return IDENTITY_PATTERNS.some(pattern => pattern.test(content))
}

export async function promoteMemories(
  dbUrl:  string,
  userId: string
): Promise<number> {
  const sql = neon(dbUrl)
  let promoted = 0

  // 1. Promote general_fact -> strong_preference (Static Rule)
  const gfCandidates = await sql`
    SELECT id, content, access_count
    FROM memories
    WHERE user_id      = ${userId}
      AND tier         = 'general_fact'
      AND is_archived  = false
      AND memory_type  = 'source'
      AND access_count >= 20
      AND created_at   <= NOW() - INTERVAL '30 days'
  `

  for (const memory of gfCandidates) {
    try {
      await sql.transaction([
        sql`
          UPDATE memories
          SET
            tier       = 'strong_preference',
            decay_rate = 0.05,
            last_accessed = NOW()
          WHERE id = ${memory.id}
        `,
        sql`
          INSERT INTO memory_promotions
            (memory_id, user_id, from_tier, to_tier, access_count, reason)
          VALUES
            (${memory.id}, ${userId}, 'general_fact', 'strong_preference',
             ${memory.access_count}, 'threshold: 20 accesses over 30 days')
        `,
      ])
      console.log(`[promotion] general_fact → strong_preference memory=${memory.id}`)
      promoted++
    } catch (err) {
      console.error(`[promotion] gf promotion failed for memory ${memory.id}:`, err)
    }
  }

  // 2. Promote strong_preference -> core_identity (Explicit Programmatic Rules)
  const spCandidates = await sql`
    SELECT id, content, access_count, created_at
    FROM memories
    WHERE user_id      = ${userId}
      AND tier         = 'strong_preference'
      AND is_archived  = false
      AND memory_type  = 'source'
      AND access_count >= 3
  `

  const now = Date.now()
  for (const memory of spCandidates) {
    const ageDays = (now - new Date(memory.created_at).getTime()) / (1000 * 60 * 60 * 24)
    let shouldPromote = false
    let reason = ''

    if (memory.access_count >= 50 && ageDays >= 90) {
      shouldPromote = true
      reason = 'Standard promotion: 50 accesses over 90 days'
    } else if (memory.access_count >= 10 && ageDays >= 3) {
      shouldPromote = true
      reason = 'High reinforcement frequency: 10 accesses over 3 days'
    } else if (memory.access_count >= 3 && ageDays >= 1 && isCoreIdentityContent(memory.content)) {
      shouldPromote = true
      reason = 'Fast-track identity fact: 3 accesses over 1 day with identity keywords'
    }

    if (shouldPromote) {
      try {
        await sql.transaction([
          sql`
            UPDATE memories
            SET
              tier       = 'core_identity',
              decay_rate = 0.01,
              last_accessed = NOW()
            WHERE id = ${memory.id}
          `,
          sql`
            INSERT INTO memory_promotions
              (memory_id, user_id, from_tier, to_tier, access_count, reason)
            VALUES
              (${memory.id}, ${userId}, 'strong_preference', 'core_identity',
               ${memory.access_count}, ${reason})
          `,
        ])
        console.log(`[promotion] strong_preference → core_identity memory=${memory.id} reason="${reason}"`)
        promoted++
      } catch (err) {
        console.error(`[promotion] sp promotion failed for memory ${memory.id}:`, err)
      }
    }
  }

  return promoted
}
