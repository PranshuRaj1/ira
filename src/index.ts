import { Hono } from 'hono'
import { neon } from '@neondatabase/serverless'
import { upsertUser, saveMemory, getRelevantMemories, pruneDecayedMemories } from './memory/store'
import { Redis } from './redis'

type Bindings = {
  BOT_TOKEN: string
  DATABASE_URL: string
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
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

app.post('/webhook', async (c) => {
  const body = await c.req.json()
  const message = body?.message
  if (!message) return c.json({ ok: true })

  const chatId = message.chat.id
  const text = message.text ?? 'no text'

  // Echo back
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