/**
 * Resilience utilities: withTimeout + CircuitBreaker
 *
 * withTimeout  — races a promise against a deadline, returns a safe fallback on timeout
 * CircuitBreaker — tracks consecutive failures via Upstash Redis; trips after N failures
 *                  and skips calls for a cooldown window, preventing cascading load on
 *                  dead services. State persists across Cloudflare Worker isolates.
 */

import { Redis } from '../redis'

// ── Timeout budgets (ms) ────────────────────────────────────────
// This is for now until i get the right latency for each layer and p50 , p90 , p99
export const TIMEOUTS = {
  PEEK_LAYER:  1000,
  MESH_LAYER:  800,
  SILK_LAYER:  3000,
  TELEGRAM:    2000,
} as const

// ── withTimeout ─────────────────────────────────────────────────

/**
 * Race a promise against a deadline. If the timer wins, return `fallback`.
 *
 * NOTE: This does NOT catch rejections — if `promise` rejects before the
 * timeout, the rejection propagates. This is intentional: callers that
 * need rejection→fallback semantics should wrap with try/catch or use
 * CircuitBreaker.call() which already swallows errors.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label?: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout>

  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => {
      console.warn(`[withTimeout] ${label ?? 'operation'} exceeded ${ms}ms — using fallback`)
      resolve(fallback)
    }, ms)
  })

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeoutHandle!))
}

// ── CircuitBreaker (Upstash Redis–backed, atomic) ───────────────

export class CircuitBreaker {
  private readonly failKey: string
  private readonly timeKey: string

  constructor(
    private readonly redis: Redis,
    service: string,
    private readonly threshold:  number = 5,
    private readonly cooldownMs: number = 60_000
  ) {
    this.failKey = `circuit:${service}:failures`
    this.timeKey = `circuit:${service}:lastFail`
  }

  async isOpen(): Promise<boolean> {
    const raw = await this.redis.get(this.failKey)
    const failures = Number(raw ?? 0)

    if (failures >= this.threshold) {
      const lastFail = Number(await this.redis.get(this.timeKey) ?? 0)
      if (Date.now() - lastFail < this.cooldownMs) return true
      // Cooldown expired — reset atomically
      await this.redis.del(this.failKey, this.timeKey)
      return false
    }
    return false
  }

  async recordFailure(): Promise<void> {
    // Write time BEFORE incrementing — if we crash mid-way,
    // the worst case is a stale timeKey with failKey at 0,
    // meaning the breaker stays closed (safe failure mode).
    // The dangerous alternative (incr first) leaves failKey
    // incremented with timeKey at 0, which causes isOpen()
    // to immediately reset — silently breaking trip logic.
    await this.redis.setRaw(this.timeKey, String(Date.now()), 3600)
    const failures = await this.redis.incr(this.failKey, 3600)

    if (failures >= this.threshold) {
      console.error(`[CircuitBreaker] ${this.failKey} TRIPPED after ${failures} failures`)
    }
  }

  async recordSuccess(): Promise<void> {
    await this.redis.del(this.failKey, this.timeKey)
  }

  /**
   * Execute `fn` through the circuit breaker.
   * If the breaker is open, returns `fallback` instantly.
   * If `fn` throws, records a failure and returns `fallback`.
   *
   * Compose with withTimeout INSIDE `fn` — not outside `call()` — so
   * that a timeout resolves cleanly without recording a false failure:
   *   breaker.call(() => withTimeout(actualWork(), ms, fb), fb, label)
   */
  async call<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
    if (await this.isOpen()) {
      console.warn(`[CircuitBreaker] ${label} is open — returning fallback`)
      return fallback
    }
    try {
      const result = await fn()
      await this.recordSuccess()
      return result
    } catch (err) {
      await this.recordFailure()
      console.error(`[CircuitBreaker] ${label} failure:`, err)
      return fallback
    }
  }
}
