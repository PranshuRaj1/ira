import { Hono } from 'hono'
import { neon } from '@neondatabase/serverless'
import { upsertUser, saveMemory, getRelevantMemories, pruneDecayedMemories } from './memory/store'



interface Env {
  DATABASE_URL: string
  TELEGRAM_BOT_TOKEN: string
}
type Bindings = {
  BOT_TOKEN: string
  DATABASE_URL: string   // add this
}

const app = new Hono<{ Bindings: { BOT_TOKEN: string,DATABASE_URL: string } }>()


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