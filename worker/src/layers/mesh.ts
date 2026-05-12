import { embed } from '../gemini'
import { getRelevantMemories } from '../memory/store'
import type { Memory } from '../memory/store'

export type MeshResult = {
  memories: Memory[]
  ms: number
}

export async function runMeshLayer(
  dbUrl: string,
  geminiApiKey: string,
  userId: string,
  message: string
): Promise<MeshResult> {
  const t0 = Date.now()

  const queryEmbedding = await embed(geminiApiKey, message)
  const memories = await getRelevantMemories(dbUrl, userId, queryEmbedding, 5)

  return { memories, ms: Date.now() - t0 }
}
