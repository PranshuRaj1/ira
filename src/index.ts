import { Hono } from 'hono'
import { neon } from '@neondatabase/serverless'
import { upsertUser, saveMemory, getRelevantMemories, pruneDecayedMemories } from './memory/store'
import { Redis } from './redis'
import { embed } from './gemini'
import { initGroqKeys } from './groq'
import { generateResponse } from './chat'

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

app.get('/test-redis', async (c) => {
  const redis = new Redis(c.env.UPSTASH_REDIS_REST_URL, c.env.UPSTASH_REDIS_REST_TOKEN)

  await redis.setSession('test-user', {
    history: [{ role: 'user', content: 'hello' }],
    lastActive: new Date().toISOString()
  })

  const session = await redis.getSession('test-user')
  await redis.pushMetric('peek', 42)
  const allowed = await redis.checkRateLimit('test-user')

  return c.json({ session, allowed })
})

app.get('/test-gemini', async (c) => {
  initGroqKeys(c.env.GROQ_API_KEY_1, c.env.GROQ_API_KEY_2)

  const embedding = await embed(c.env.GEMINI_API_KEY, 'I like coffee')
  
  const response = await generateResponse(
    'What do I like?',
    ['user likes coffee', 'user is a developer'],
    []
  )

  return c.json({ dims: embedding.length, response })
})

app.post('/webhook', async (c) => {
  initGroqKeys(c.env.GROQ_API_KEY_1, c.env.GROQ_API_KEY_2)

  const body = await c.req.json()
  const message = body?.message
  if (!message) return c.json({ ok: true })

  const chatId = message.chat.id
  const text = message.text ?? 'no text'

  // Echo back (temporary, will be replaced in Step 7)
  await fetch(
    `https://api.telegram.org/bot${c.env.BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `You said: ${text}` })
    }
  )

  return c.json({ ok: true })
})

export default app