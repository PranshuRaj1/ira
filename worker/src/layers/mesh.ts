import { embed } from '../gemini'
import { getRelevantMemories } from '../memory/store'
import { rankByDecay } from '../memory/decay'
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
  const rawMemories = await getRelevantMemories(dbUrl, userId, queryEmbedding, 10)
  const ranked = rankByDecay(rawMemories).slice(0, 5)

  return { memories: ranked, ms: Date.now() - t0 }
}
