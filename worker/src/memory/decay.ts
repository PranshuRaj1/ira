import type { Memory } from './store'

export function decayedImportance(memory: Memory, now = new Date()): number {
  const daysSince =
    (now.getTime() - memory.lastAccessed.getTime()) / 86400000
  return memory.importance * Math.exp(-memory.decayRate * daysSince)
}

export function rankByDecay(memories: Memory[]): Memory[] {
  const now = new Date()
  return [...memories].sort(
    (a, b) => decayedImportance(b, now) - decayedImportance(a, now)
  )
}
