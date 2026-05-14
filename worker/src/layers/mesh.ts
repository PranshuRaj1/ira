import { embed } from '../gemini'
import { getRelevantMemories, deepRecallMemories, resurface } from '../memory/store'
import type { Memory } from '../memory/store'

export type MeshResult = {
  memories: Memory[]
  ms: number
  source: 'normal' | 'deep_recall'
}

const DEEP_RECALL_TRIGGERS = [
  /remember when/i,
  /a while back/i,
  /long time ago/i,
  /months? ago/i,
  /years? ago/i,
  /we (used to|once) talk/i,
  /old memories?/i,
  /forgot about/i,
]

export function requiresDeepRecall(userMessage: string): boolean {
  return DEEP_RECALL_TRIGGERS.some(pattern => pattern.test(userMessage))
}

export async function runMeshLayer(
  dbUrl: string,
  geminiApiKey: string,
  userId: string,
  message: string
): Promise<MeshResult> {
  const t0 = Date.now()

  const queryEmbedding = await embed(geminiApiKey, message)
  
  if (requiresDeepRecall(message)) {
    const active = await getRelevantMemories(dbUrl, userId, queryEmbedding, 5)
    const archived = await deepRecallMemories(dbUrl, userId, queryEmbedding, 5)
    
    // Automatically resurface recalled memories
    for (const mem of archived) {
      await resurface(dbUrl, mem.id).catch(console.error)
    }

    return { 
      memories: [...active, ...archived], 
      ms: Date.now() - t0, 
      source: 'deep_recall' 
    }
  }

  const memories = await getRelevantMemories(dbUrl, userId, queryEmbedding, 5)

  return { memories, ms: Date.now() - t0, source: 'normal' }
}
