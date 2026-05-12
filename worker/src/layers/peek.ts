import { classifyIntent } from '../chat'
import { ImportanceTier } from '../types'

export type PeekResult = {
  intent: 'question' | 'statement' | 'command' | 'greeting' | 'other'
  shouldSaveMemory: boolean
  memoryHint: string | null
  tier: ImportanceTier
  ms: number
}

export async function runPeekLayer(message: string): Promise<PeekResult> {
  const t0 = Date.now()
  const result = await classifyIntent(message)
  return { ...result, ms: Date.now() - t0 }
}
