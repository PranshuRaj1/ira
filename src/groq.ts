const GROQ_BASE = 'https://api.groq.com/openai/v1'
const MODEL = 'llama-3.3-70b-versatile'

let keyQueue: string[] = []

export function initGroqKeys(...keys: string[]) {
  keyQueue = keys.filter(Boolean)
}

function rotateKey(): string {
  if (keyQueue.length === 0) throw new Error('No Groq API keys available')
  const key = keyQueue.shift()!
  keyQueue.push(key)
  return key
}

export async function groqChat(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  maxTokens = 500,
  temperature = 0.7,
  retries = keyQueue.length || 2
): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const key = rotateKey()

    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature
      })
    })

    const data = await res.json() as any

    if (data.error) {
      const isQuota = data.error.type === 'tokens' || 
                      data.error.code === 'rate_limit_exceeded'
      
      if (isQuota && attempt < retries - 1) {
        console.warn(`Groq key quota hit, rotating to next key...`)
        continue
      }
      throw new Error(`Groq Error: ${data.error.message}`)
    }

    return data.choices[0].message.content as string
  }

  throw new Error('All Groq API keys exhausted')
}
