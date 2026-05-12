import { neon } from '@neondatabase/serverless'
import { askYesNo } from '../chat'
import { ImportanceTier, TIER_CONFIG, TIER_RANK } from '../types'

export async function resolveContradictions(
  dbUrl: string,
  userId: string,
  newContent: string,
  newTier: ImportanceTier,
  similarMemories: { id: string; content: string; importance: number; tier: string }[]
): Promise<void> {
  const sql = neon(dbUrl)

  for (const old of similarMemories) {
    const question = `Do these two facts directly contradict each other?
Fact 1: "${old.content}"
Fact 2: "${newContent}"
Answer only yes or no.`

    const contradicts = await askYesNo(question)

    if (contradicts) {
      const existingTier = (old.tier ?? 'general_fact') as ImportanceTier
      const newConfig = TIER_CONFIG[newTier]

      if (TIER_RANK[newTier] >= TIER_RANK[existingTier]) {
        // new memory is equal or higher tier — it wins
        await sql`
          UPDATE memories SET importance = 0.1
          WHERE id = ${old.id}
        `
        // the new memory already has its full importance from the INSERT
      } else {
        const demotedImportance = +(old.importance * 0.8).toFixed(4)
        await sql`
          UPDATE memories
          SET importance = ${demotedImportance}
          WHERE id = ${old.id}
        `
      }
    }
  }
}
