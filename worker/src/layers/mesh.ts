import { embed } from '../gemini'
import { getRelevantMemories, deepRecallMemories, resurface, getPinnedIdentityMemories } from '../memory/store'
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

/**
 * Merges pinned identity memories with similarity results,
 * deduplicating by id. Identity memories are prepended so the LLM
 * always sees the user's name/age/etc first, regardless of query relevance.
 */
function mergeWithIdentity(pinned: Memory[], similar: Memory[]): Memory[] {
  const seen = new Set(pinned.map(m => m.id))
  const unique = similar.filter(m => !seen.has(m.id))
  return [...pinned, ...unique]
}

export async function runMeshLayer(
  dbUrl: string,
  geminiApiKey: string,
  userId: string,
  message: string
): Promise<MeshResult> {
  const t0 = Date.now()

  // Always fetch core_identity in parallel with the embedding — it's a fast
  // direct-by-tier query and ensures the user's name is NEVER crowded out.
  const [queryEmbedding, pinned] = await Promise.all([
    embed(geminiApiKey, message),
    getPinnedIdentityMemories(dbUrl, userId),
  ])
  
  if (requiresDeepRecall(message)) {
    const active = await getRelevantMemories(dbUrl, userId, queryEmbedding, 5)
    const archived = await deepRecallMemories(dbUrl, userId, queryEmbedding, 5)
    
    // Automatically resurface recalled memories
    for (const mem of archived) {
      await resurface(dbUrl, mem.id).catch(console.error)
    }

    return { 
      memories: mergeWithIdentity(pinned, [...active, ...archived]), 
      ms: Date.now() - t0, 
      source: 'deep_recall' 
    }
  }

  const similar = await getRelevantMemories(dbUrl, userId, queryEmbedding, 5)
  const memories = mergeWithIdentity(pinned, similar)

  return { memories, ms: Date.now() - t0, source: 'normal' }
}
