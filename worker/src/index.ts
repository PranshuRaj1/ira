import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { neon } from '@neondatabase/serverless'
import { Redis } from './redis'
import { initGroqKeys } from './groq'
import { embed } from './gemini'
import { upsertUser, saveMemoryWithContradictionCheck, logAdversarialAttempt, isMemorySafe, logSuspiciousMemoryAttempt } from './memory/store'
import { DECAY_SCORE_EXPR } from './lib/decay'
import { withTimeout, CircuitBreaker, TIMEOUTS } from './lib/resilience'
import { consolidateMemories, rollbackConsolidation } from './lib/consolidation'
import { promoteMemories } from './lib/promotion'
import { runPeekLayer } from './layers/peek'
import { runMeshLayer } from './layers/mesh'
import { runSilkLayer } from './layers/silk'
import { sanitizeMessageForContext, detectAttackType } from './lib/sanitization'
import type { PeekResult } from './layers/peek'
import type { MeshResult } from './layers/mesh'
import type { Session } from './types'

type Bindings = {
  BOT_TOKEN: string
  DATABASE_URL: string
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
  GEMINI_API_KEY: string
  GROQ_API_KEY_1: string
  GROQ_API_KEY_2: string
  DEBUG_SECRET: string
}

// ── Module-level cached Neon client ─────────────────────────────
// Reused across requests in the same warm worker instance.
// Prevents creating a new client (and new TCP handshake) on every request.
let _sql: ReturnType<typeof neon> | null = null

// ── Safe fallbacks when a layer times out or circuit trips ──────

const PEEK_FALLBACK: PeekResult = {
  intent: 'other',
  shouldSaveMemory: false,
  memoryHint: null,
  tier: 'trivial',
  ms: 0,
  adversarialFlag: false,
}

const MESH_FALLBACK: MeshResult = {
  memories: [],
  ms: 0,
  source: 'normal',
}

// ── App ─────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

app.get('/', (c) => c.text('IRA is running'))

// ── Webhook (instant 200 via waitUntil) ─────────────────────────

app.post('/webhook', async (c) => {
  const body = await c.req.json()
  const message = body?.message
  if (!message?.text) return c.json({ ok: true })

  // Fire-and-forget: all LLM work happens in the background
  c.executionCtx.waitUntil(
    processMessage(body, c.env)
  )

  // Telegram gets its 200 instantly — no retries triggered
  return c.json({ ok: true })
})

// ── Core message processing (runs inside waitUntil) ─────────────

async function processMessage(body: any, env: Bindings): Promise<void> {
  try {
    const message = body?.message
    const chatId = message.chat.id
    const userId = String(chatId)
    const rawText = message.text as string
    const text   = sanitizeMessageForContext(rawText)

    // Init Groq key rotation (using 2 keys as requested)
    initGroqKeys(
      env.GROQ_API_KEY_1,
      env.GROQ_API_KEY_2
    )

    const redis = new Redis(
      env.UPSTASH_REDIS_REST_URL,
      env.UPSTASH_REDIS_REST_TOKEN
    )

    // Rate limit
    const allowed = await redis.checkRateLimit(userId)
    if (!allowed) {
      await sendTelegram(env.BOT_TOKEN, chatId, "Slow down! Try again in a minute.")
      return
    }

    // Ensure user exists
    await upsertUser(env.DATABASE_URL, userId)

    // Load session
    const session = await redis.getSession<Session>(userId) ?? {
      history: [],
      lastActive: new Date().toISOString()
    }

    // ── Circuit breakers ──────────────────────────────────────────
    const groqBreaker   = new CircuitBreaker(redis, 'groq')
    const geminiBreaker = new CircuitBreaker(redis, 'gemini')

    // ── Run Peek + Mesh in parallel with timeouts ─────────────────
    const [peek, mesh] = await Promise.all([
      groqBreaker.call(
        () => withTimeout(
          runPeekLayer(rawText),
          TIMEOUTS.PEEK_LAYER,
          PEEK_FALLBACK,
          'peek-layer'
        ),
        PEEK_FALLBACK,
        'groq-peek'
      ),
      geminiBreaker.call(
        () => withTimeout(
          runMeshLayer(env.DATABASE_URL, env.GEMINI_API_KEY, userId, text),
          TIMEOUTS.MESH_LAYER,
          MESH_FALLBACK,
          'mesh-layer'
        ),
        MESH_FALLBACK,
        'gemini-mesh'
      ),
    ])

    if (peek.adversarialFlag) {
      await recordAdversarialStrike(redis, userId)
      const attackType = detectAttackType(rawText)
      await logAdversarialAttempt(env.DATABASE_URL, userId, rawText, attackType)
      await withTimeout(
        sendTelegram(env.BOT_TOKEN, chatId, "I noticed that message was trying to change how I work. I'm still just IRA. What did you actually want to talk about?"),
        TIMEOUTS.TELEGRAM,
        undefined,
        'telegram-send'
      )
      return
    }

    // Silk runs after both — also with a timeout
    const silk = await groqBreaker.call(
      () => withTimeout(
        runSilkLayer(text, peek, mesh, session),
        TIMEOUTS.SILK_LAYER,
        { response: "Sorry, I'm a bit slow right now. Please try again.", ms: 0 },
        'silk-layer'
      ),
      { response: "I'm having trouble thinking right now. Please try again.", ms: 0 },
      'groq-silk'
    )

    // Save memory if Peek flagged it (non-critical, best-effort)
    if (peek.shouldSaveMemory && peek.memoryHint) {
      if (isMemorySafe(peek.memoryHint)) {
        try {
          const embedding = await embed(env.GEMINI_API_KEY, peek.memoryHint)
          // User message path is restricted: only system can write core_identity.
          // Therefore, if it is core_identity from the user path, we downgrade to strong_preference.
          const tier = peek.tier === 'core_identity' ? 'strong_preference' : peek.tier
          await saveMemoryWithContradictionCheck(
            env.DATABASE_URL,
            userId,
            peek.memoryHint,
            embedding,
            tier,
            [],
            'user'
          )
        } catch (err) {
          console.error('Memory save failed (non-critical):', err)
        }
      } else {
        try {
          await logSuspiciousMemoryAttempt(env.DATABASE_URL, userId, peek.memoryHint)
        } catch (err) {
          console.error('Logging suspicious memory failed:', err)
        }
      }
    }

    // Update session
    session.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: silk.response }
    )
    if (session.history.length > 20) session.history = session.history.slice(-20)
    session.lastActive = new Date().toISOString()
    await redis.setSession(userId, session)

    // Track metrics
    await Promise.all([
      redis.pushMetric('peek', peek.ms),
      redis.pushMetric('mesh', mesh.ms),
      redis.pushMetric('silk', silk.ms),
    ])

    // Reply to user via Telegram Bot API
    await withTimeout(
      sendTelegram(env.BOT_TOKEN, chatId, silk.response),
      TIMEOUTS.TELEGRAM,
      undefined,
      'telegram-send'
    )
  } catch (err) {
    console.error('processMessage failed:', err)
    // Best-effort error reply
    try {
      const chatId = body?.message?.chat?.id
      if (chatId) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "Something went wrong. Please try again."
        )
      }
    } catch { /* swallow — nothing more we can do */ }
  }
}

function requireDebugSecret(c: Context<{ Bindings: Bindings }>): boolean {
  const secret = c.req.header('x-debug-secret')
  return secret === c.env.DEBUG_SECRET
}

// ── Dashboard endpoints ─────────────────────────────────────────

app.get('/memories', async (c) => {
  const sql = neon(c.env.DATABASE_URL)
  const rows = await sql`
    SELECT 
      user_id, content, importance, access_count,
      last_accessed, created_at,
      ${sql.unsafe(DECAY_SCORE_EXPR())} AS decayed_importance
    FROM memories
    WHERE is_archived = false
    ORDER BY decayed_importance DESC
    LIMIT 50
  `
  return c.json({ memories: rows })
})

app.get('/metrics', async (c) => {
  const redis = new Redis(
    c.env.UPSTASH_REDIS_REST_URL,
    c.env.UPSTASH_REDIS_REST_TOKEN
  )

  const [peekRaw, meshRaw, silkRaw] = await Promise.all([
    redis.getMetrics('peek'),
    redis.getMetrics('mesh'),
    redis.getMetrics('silk'),
  ])

  return c.json({
    peek: percentiles(peekRaw),
    mesh: percentiles(meshRaw),
    silk: percentiles(silkRaw),
    totalRequests: peekRaw.length
  })
})

// ── Helpers ─────────────────────────────────────────────────────

function percentiles(values: number[]) {
  if (values.length === 0) return { p50: 0, p90: 0, p99: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const p = (pct: number) => sorted[Math.floor((pct / 100) * sorted.length)] ?? 0
  return { p50: p(50), p90: p(90), p99: p(99) }
}

async function sendTelegram(token: string, chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`sendTelegram failed: ${res.status} ${body}`)
  }
}

// ── Admin endpoints ─────────────────────────────────────────────

app.post('/admin/rollback-consolidation', async (c) => {
  if (!requireDebugSecret(c)) return c.json({ error: 'unauthorized' }, 401)

  const { consolidationId } = await c.req.json<{ consolidationId: string }>()
  if (!consolidationId) return c.json({ error: 'consolidationId required' }, 400)

  await rollbackConsolidation(c.env.DATABASE_URL, consolidationId)
  return c.json({ ok: true, rolledBack: consolidationId })
})

// ── Sleep cycle cron ─────────────────────────────────────────────
// Runs daily at 3 AM UTC via wrangler.jsonc cron trigger

async function runSleepCycle(env: Bindings): Promise<void> {
  const sql = neon(env.DATABASE_URL)

  // Only process users active in the last 7 days
  const users = await sql`
    SELECT DISTINCT user_id
    FROM memories
    WHERE last_accessed >= NOW() - INTERVAL '7 days'
      AND is_archived   = false
  `

  console.log(`[sleep-cycle] processing ${users.length} active users`)

  for (const { user_id } of users) {
    try {
      // Promote first — freshly promoted memories become eligible
      // for consolidation at their new tier in the same cycle.
      const promoted = await promoteMemories(env.DATABASE_URL, user_id)

      const result = await consolidateMemories(
        env.DATABASE_URL,
        env.GEMINI_API_KEY,
        user_id
      )

      console.log(`[sleep-cycle] user=${user_id}`, { promoted, ...result })
    } catch (err) {
      console.error(`[sleep-cycle] failed for user=${user_id}:`, err)
    }
  }
}

async function recordAdversarialStrike(redis: Redis, userId: string): Promise<void> {
  const session = await redis.getSession<Session>(userId) ?? {
    history: [],
    lastActive: new Date().toISOString()
  }
  
  const now = Date.now()
  let strikes = session.adversarialStrikes || 0
  
  // TTL-based reset: If 24 hours have passed since last adversarial hit, decay strikes to 0
  if (session.lastAdversarialAt && now - session.lastAdversarialAt > 24 * 60 * 60 * 1000) {
    strikes = 0
  }
  
  session.adversarialStrikes = Math.min(strikes + 1, 99)
  session.lastAdversarialAt = now
  await redis.setSession(userId, session)
}

// ── Cloudflare Worker exports ────────────────────────────────────

export default {
  // HTTP routes — wrap app.fetch to add connection warmup
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    // Warmup: fire SELECT 1 without awaiting to start the Neon TCP
    // handshake immediately on request arrival. By the time the Mesh
    // layer actually queries the DB, the connection is already warm.
    // Using a module-level cached client avoids creating a new instance
    // (and new handshake) on every single request.
    if (env.DATABASE_URL) {
      if (!_sql) _sql = neon(env.DATABASE_URL)
      _sql`SELECT 1`.catch(() => {})
    }
    return app.fetch(request, env, ctx)
  },

  // Cron trigger — Cloudflare calls this on the schedule in wrangler.jsonc
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runSleepCycle(env))
  },
}