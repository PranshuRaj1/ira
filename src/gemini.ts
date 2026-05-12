const BASE = 'https://generativelanguage.googleapis.com/v1beta'

export async function embed(
  apiKey: string,
  text: string
): Promise<number[]> {
  const res = await fetch(
    `${BASE}/models/gemini-embedding-2:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-2',
        content: { parts: [{ text }] }
      })
    }
  )
  const data = await res.json() as any

  if (data.error) {
    throw new Error(`Gemini Embed Error: ${data.error.message}`)
  }

  return data.embedding.values
}