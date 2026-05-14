import { withTimeout, CircuitBreaker } from '../../src/lib/resilience'

// ── Mock Redis using atomic incr/del (matches real Redis semantics) ──

class MockRedis {
  private store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async setRaw(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.store.get(key) ?? 0)
    const next = current + 1
    this.store.set(key, String(next))
    return next
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k)
  }
}

// ── Test 1: withTimeout returns fallback when promise is slow ────

async function testWithTimeoutFallback() {
  const slowOp = new Promise<string>(resolve =>
    setTimeout(() => resolve('slow result'), 2000)
  )

  const result = await withTimeout(slowOp, 200, 'fallback used', 'test-slow-op')

  if (result === 'fallback used') {
    console.log('✓ withTimeout: correctly returned fallback for slow promise')
  } else {
    console.error(`✗ withTimeout: expected 'fallback used', got '${result}'`)
  }
}

// ── Test 2: withTimeout passes through when promise is fast ──────

async function testWithTimeoutPassthrough() {
  const fastOp = new Promise<string>(resolve =>
    setTimeout(() => resolve('fast result'), 10)
  )

  const result = await withTimeout(fastOp, 500, 'fallback', 'test-fast-op')

  if (result === 'fast result') {
    console.log('✓ withTimeout: correctly returned fast promise result')
  } else {
    console.error(`✗ withTimeout: expected 'fast result', got '${result}'`)
  }
}

// ── Test 3: withTimeout propagates rejection (by design) ─────────

async function testWithTimeoutRejection() {
  const failOp = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('boom')), 10)
  )

  try {
    await withTimeout(failOp, 500, 'fallback', 'test-reject')
    console.error('✗ withTimeout: should have thrown on rejection')
  } catch {
    console.log('✓ withTimeout: correctly propagated rejection (by design)')
  }
}

// ── Test 4: CircuitBreaker trips after threshold ─────────────────

async function testCircuitBreakerTrips() {
  const mock = new MockRedis() as any
  const breaker = new CircuitBreaker(mock, 'test-trip', 3, 500)

  // Should start closed
  let open = await breaker.isOpen()
  if (open) {
    console.error('✗ CircuitBreaker: should start closed')
    return
  }
  console.log('✓ CircuitBreaker: starts closed')

  // Record 3 failures → should trip
  await breaker.recordFailure()
  await breaker.recordFailure()
  await breaker.recordFailure()

  open = await breaker.isOpen()
  if (!open) {
    console.error('✗ CircuitBreaker: should be open after 3 failures')
    return
  }
  console.log('✓ CircuitBreaker: trips after threshold')

  // call() should return fallback while open
  const result = await breaker.call(
    async () => 'real value',
    'fallback value',
    'test-call'
  )
  if (result === 'fallback value') {
    console.log('✓ CircuitBreaker: call() returns fallback when open')
  } else {
    console.error(`✗ CircuitBreaker: expected 'fallback value', got '${result}'`)
  }

  // Wait for cooldown (500ms)
  await new Promise(r => setTimeout(r, 600))

  open = await breaker.isOpen()
  if (open) {
    console.error('✗ CircuitBreaker: should reset after cooldown')
    return
  }
  console.log('✓ CircuitBreaker: resets after cooldown')

  // call() should pass through now
  const result2 = await breaker.call(
    async () => 'real value',
    'fallback value',
    'test-call-2'
  )
  if (result2 === 'real value') {
    console.log('✓ CircuitBreaker: call() passes through when closed')
  } else {
    console.error(`✗ CircuitBreaker: expected 'real value', got '${result2}'`)
  }
}

// ── Test 5: CircuitBreaker.call() catches errors & degrades ──────

async function testCircuitBreakerCallDegrades() {
  const mock = new MockRedis() as any
  const breaker = new CircuitBreaker(mock, 'test-degrade', 3, 5000)

  const result = await breaker.call(
    async () => { throw new Error('service down') },
    'graceful fallback',
    'test-degrade'
  )

  if (result === 'graceful fallback') {
    console.log('✓ CircuitBreaker.call(): returns fallback on error')
  } else {
    console.error(`✗ CircuitBreaker.call(): expected 'graceful fallback', got '${result}'`)
  }
}

// ── Test 6: Correct composition — breaker wraps withTimeout ──────
// A slow service times out cleanly. The breaker sees a successful
// fallback return, NOT a rejection — so no false failure is recorded.

async function testCorrectComposition() {
  const mock = new MockRedis() as any
  const breaker = new CircuitBreaker(mock, 'test-compose', 5, 5000)

  const result = await breaker.call(
    () => withTimeout(
      new Promise<string>(resolve => setTimeout(() => resolve('slow'), 2000)),
      200,
      'timeout-fallback',
      'compose-timeout'
    ),
    'breaker-fallback',
    'compose-test'
  )

  if (result === 'timeout-fallback') {
    console.log('✓ Composition: breaker sees timeout fallback as success (no false trip)')
  } else {
    console.error(`✗ Composition: expected 'timeout-fallback', got '${result}'`)
  }

  // Verify the breaker did NOT record a failure
  const open = await breaker.isOpen()
  if (!open) {
    console.log('✓ Composition: breaker stays closed after timeout (no false failure)')
  } else {
    console.error('✗ Composition: breaker falsely tripped on timeout')
  }
}

// ── Test 7: Atomic INCR — concurrent failures count correctly ────

async function testAtomicIncrement() {
  const mock = new MockRedis() as any
  const breaker = new CircuitBreaker(mock, 'test-atomic', 3, 5000)

  // Simulate 3 concurrent failures
  await Promise.all([
    breaker.recordFailure(),
    breaker.recordFailure(),
    breaker.recordFailure(),
  ])

  const open = await breaker.isOpen()
  if (open) {
    console.log('✓ Atomic: concurrent failures correctly tripped breaker')
  } else {
    console.error('✗ Atomic: concurrent failures lost — breaker not tripped')
  }
}

// ── Run all tests ────────────────────────────────────────────────

async function main() {
  console.log('--- RESILIENCE UTILITIES TEST ---\n')

  await testWithTimeoutFallback()
  await testWithTimeoutPassthrough()
  await testWithTimeoutRejection()
  await testCircuitBreakerTrips()
  await testCircuitBreakerCallDegrades()
  await testCorrectComposition()
  await testAtomicIncrement()

  console.log('\n--- ALL TESTS COMPLETE ---')
}

main().catch(console.error)
