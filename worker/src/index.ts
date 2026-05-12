import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { neon } from '@neondatabase/serverless'
import { Redis } from './redis'
import { initGroqKeys } from './groq'
import { embed } from './gemini'
import { upsertUser } from './memory/store'
import { saveMemoryWithContradictionCheck } from './memory/store'
import { runPeekLayer } from './layers/peek'
import { runMeshLayer } from './layers/mesh'
import { runSilkLayer } from './layers/silk'
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

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

app.get('/', (c) => c.text('IRA is running'))

app.post('/webhook', async (c) => {
  try {
    const body = await c.req.json()
    const message = body?.message
    if (!message?.text) return c.json({ ok: true })

    const chatId = message.chat.id
    const userId = String(chatId)
    const text = message.text as string

    // Init Groq key rotation (using 2 keys as requested)
    initGroqKeys(
      c.env.GROQ_API_KEY_1,
      c.env.GROQ_API_KEY_2
    )

    const redis = new Redis(
      c.env.UPSTASH_REDIS_REST_URL,
      c.env.UPSTASH_REDIS_REST_TOKEN
    )

    // Rate limit
    const allowed = await redis.checkRateLimit(userId)
    if (!allowed) {
      await sendTelegram(c.env.BOT_TOKEN, chatId, "Slow down! Try again in a minute.")
      return c.json({ ok: true })
    }

    // Ensure user exists
    await upsertUser(c.env.DATABASE_URL, userId)

    // Load session
    const session = await redis.getSession<Session>(userId) ?? {
      history: [],
      lastActive: new Date().toISOString()
    }

    // Run Peek + Mesh in parallel
    const [peek, mesh] = await Promise.all([
      runPeekLayer(text),
      runMeshLayer(c.env.DATABASE_URL, c.env.GEMINI_API_KEY, userId, text)
    ])

    // Silk runs after both
    const silk = await runSilkLayer(text, peek, mesh, session)

    // Save memory if Peek flagged it
    if (peek.shouldSaveMemory && peek.memoryHint) {
      const embedding = await embed(c.env.GEMINI_API_KEY, peek.memoryHint)
      await saveMemoryWithContradictionCheck(
        c.env.DATABASE_URL,
        userId,
        peek.memoryHint,
        embedding,
        peek.tier
      )
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

    // Reply
    await sendTelegram(c.env.BOT_TOKEN, chatId, silk.response)
  } catch (err) {
    // Always return 200 to Telegram to prevent infinite retries
    console.error("Webhook error:", err)
  }

  return c.json({ ok: true })
})

app.get('/memories', async (c) => {
  const sql = neon(c.env.DATABASE_URL)
  const rows = await sql`
    SELECT 
      user_id, content, importance, access_count,
      last_accessed, created_at,
      importance * EXP(
        -decay_rate * EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400
      ) AS decayed_importance
    FROM memories
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

function percentiles(values: number[]) {
  if (values.length === 0) return { p50: 0, p90: 0, p99: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const p = (pct: number) => sorted[Math.floor((pct / 100) * sorted.length)] ?? 0
  return { p50: p(50), p90: p(90), p99: p(99) }
}

async function sendTelegram(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  })
}

export default app