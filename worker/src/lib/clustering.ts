/**
 * Centroid-based memory clustering for consolidation.
 *
 * Algorithm:
 *   1. Sort by access_count DESC so high-signal memories seed clusters.
 *   2. For each unvisited seed, gather neighbors within SIMILARITY_THRESHOLD.
 *   3. Recompute centroid of that draft cluster.
 *   4. Re-validate: keep only members still within threshold of the centroid.
 *      This removes anchor-biased outliers (close to seed but not to the
 *      cluster as a whole) — the core gap in a pure greedy anchor approach.
 *   5. If the tightened cluster still meets MIN_CLUSTER_SIZE, emit it.
 *      Otherwise release non-anchor members back into the pool.
 *
 * Complexity: O(n² × d) where d = embedding dimension.
 * Acceptable for n ≤ 200 candidates (the fetch limit).  Will try to optimise this step later on.
 */

export const SIMILARITY_THRESHOLD     = 0.82   // 0.85 misses related memories with different phrasing
export const MIN_CLUSTER_SIZE         = 3
export const MAX_CLUSTER_SIZE         = 10
export const MIN_ACCESS_COUNT         = 5
export const CONSOLIDATION_WINDOW_DAYS = 30
export const MIN_CONFIDENCE           = 0.7    // LLM confidence below this → skip the cluster

export type CandidateMemory = {
  id:           string
  content:      string
  embedding:    number[]
  importance:   number
  access_count: number
  tier:         string
}

// ── Math helpers ─────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

function centroid(memories: CandidateMemory[]): number[] {
  const dim = memories[0].embedding.length
  const sum = new Array<number>(dim).fill(0)
  for (const m of memories) {
    for (let i = 0; i < dim; i++) sum[i] += m.embedding[i]
  }
  return sum.map(v => v / memories.length)
}

// ── Main clustering function ─────────────────────────────────────

export function clusterMemories(memories: CandidateMemory[]): CandidateMemory[][] {
  const visited  = new Set<string>()
  const clusters: CandidateMemory[][] = []

  // Sort by access_count DESC — most-recalled memories seed clusters
  const sorted = [...memories].sort((a, b) => b.access_count - a.access_count)

  for (const seed of sorted) {
    if (visited.has(seed.id)) continue

    // Pass 1: gather neighbors within threshold of the seed
    const draft: CandidateMemory[] = [seed]
    visited.add(seed.id)

    for (const candidate of sorted) {
      if (visited.has(candidate.id)) continue
      if (draft.length >= MAX_CLUSTER_SIZE) break
      if (cosineSim(seed.embedding, candidate.embedding) >= SIMILARITY_THRESHOLD) {
        draft.push(candidate)
        visited.add(candidate.id)
      }
    }

    if (draft.length < MIN_CLUSTER_SIZE) {
      // Release non-seed members back into the pool
      for (const m of draft.slice(1)) visited.delete(m.id)
      continue
    }

    // Pass 2: recompute centroid and re-validate
    // This removes anchor-biased outliers (members close to seed
    // but not representative of the cluster as a whole).
    const c = centroid(draft)
    const tight = draft.filter(m => cosineSim(c, m.embedding) >= SIMILARITY_THRESHOLD)

    if (tight.length >= MIN_CLUSTER_SIZE) {
      // Keep the tight cluster, but release any members dropped by re-validation
      const tightIds = new Set(tight.map(m => m.id))
      for (const m of draft) {
        if (!tightIds.has(m.id)) visited.delete(m.id)
      }
      clusters.push(tight)
    } else {
      // Whole draft is too loose — release all non-seed members
      for (const m of draft.slice(1)) visited.delete(m.id)
    }
  }

  return clusters
}
