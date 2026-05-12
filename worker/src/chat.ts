import { groqChat } from './groq'

export async function generateResponse(
  userMessage: string,
  memories: string[],
  history: { role: string; content: string }[]
): Promise<string> {
  const systemPrompt = memories.length > 0
    ? `You are IRA, a helpful assistant with memory.

What you remember about this user:
${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Use these memories naturally in conversation when relevant. Be concise.`
    : `You are IRA, a helpful assistant. Be concise.`

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history.slice(-10).map(h => ({
      role: h.role as 'user' | 'assistant',
      content: h.content
    })),
    { role: 'user' as const, content: userMessage }
  ]

  return groqChat(messages, 500, 0.7)
}

export async function classifyIntent(message: string): Promise<{
  intent: 'question' | 'statement' | 'command' | 'greeting' | 'other'
  shouldSaveMemory: boolean
  memoryHint: string | null
}> {
  const messages = [
    {
      role: 'system' as const,
      content: `You are an intent classifier. Respond ONLY with valid JSON, no markdown, no explanation.`
    },
    {
      role: 'user' as const,
      content: `Classify this message:
{
  "intent": "question|statement|command|greeting|other",
  "shouldSaveMemory": true/false,
  "memoryHint": "concise fact to remember, or null"
}

Save memory only if message reveals something personal about the user (name, preference, job, location etc).

Message: "${message}"`
    }
  ]

  const raw = await groqChat(messages, 100, 0)
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    // If Groq returns a rate limit error or malformed JSON, skip memory save
    console.warn("classifyIntent parse failed, raw was:", raw)
    return { intent: 'other', shouldSaveMemory: false, memoryHint: null }
  }
}

export async function askYesNo(question: string): Promise<boolean> {
  const messages = [
    {
      role: 'system' as const,
      content: 'Answer only with yes or no. Nothing else.'
    },
    { role: 'user' as const, content: question }
  ]
  const answer = await groqChat(messages, 5, 0)
  return answer.toLowerCase().includes('yes')
}
