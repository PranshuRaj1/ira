import { neon } from '@neondatabase/serverless'
import { askYesNo } from '../chat'

export async function resolveContradictions(
  dbUrl: string,
  userId: string,
  newContent: string,
  similarMemories: { id: string; content: string }[]
): Promise<void> {
  const sql = neon(dbUrl)

  for (const old of similarMemories) {
    const question = `Do these two facts directly contradict each other?
Fact 1: "${old.content}"
Fact 2: "${newContent}"
Answer only yes or no.`

    const contradicts = await askYesNo(question)

    if (contradicts) {
      await sql`
        UPDATE memories SET importance = 0.1
        WHERE id = ${old.id} AND user_id = ${userId}
      `
      await sql`
        UPDATE memories SET importance = 0.9
        WHERE user_id = ${userId} AND content = ${newContent}
      `
    }
  }
}
