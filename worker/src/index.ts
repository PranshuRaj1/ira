import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { neon } from '@neondatabase/serverless'
import { Redis } from './redis'
import { initGroqKeys } from './groq'
import { embed } from './gemini'
import { upsertUser } from './memory/store'
import { saveMemoryWithContradictionCheck } from './memory/store'
import { DECAY_SCORE_EXPR } from './lib/decay'
import { withTimeout, CircuitBreaker, TIMEOUTS } from './lib/resilience'
import { runPeekLayer } from './layers/peek'
import { runMeshLayer } from './layers/mesh'
import { runSilkLayer } from './layers/silk'
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
}

// ── Safe fallbacks when a layer times out or circuit trips ──────

const PEEK_FALLBACK: PeekResult = {
  intent: 'other',
  shouldSaveMemory: false,
  memoryHint: null,
  tier: 'trivial',
  ms: 0,
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

// ── Webhook (Change 7: instant 200 via waitUntil) ───────────────

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
    const text   = message.text as string

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

    // ── Circuit breakers (Change 6: state persisted in Upstash) ──
    const groqBreaker   = new CircuitBreaker(redis, 'groq')
    const geminiBreaker = new CircuitBreaker(redis, 'gemini')

    // ── Run Peek + Mesh in parallel with timeouts (Change 5) ─────
    // Breaker wraps withTimeout — so a timeout returns fallback cleanly
    // without recording a false failure on the breaker.
    const [peek, mesh] = await Promise.all([
      groqBreaker.call(
        () => withTimeout(
          runPeekLayer(text),
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
      try {
        const embedding = await embed(env.GEMINI_API_KEY, peek.memoryHint)
        await saveMemoryWithContradictionCheck(
          env.DATABASE_URL,
          userId,
          peek.memoryHint,
          embedding,
          peek.tier
        )
      } catch (err) {
        console.error('Memory save failed (non-critical):', err)
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

export default app