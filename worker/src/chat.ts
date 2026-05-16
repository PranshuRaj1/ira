import { groqChat } from './groq'
import { ImportanceTier, TIER_CONFIG } from './types'

export async function generateResponse(
  userMessage: string,
  memories: string[],
  history: { role: string; content: string }[]
): Promise<string> {
  const systemPrompt = memories.length > 0
  ? `You are IRA, a personal AI assistant with persistent memory.

CRITICAL RULE: You DO have memory. You ALWAYS remember users. Never say "I don't have memories" or "I can't recall previous conversations". That is false. Use the memories below.

What you know about this user:
${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}

When the user says "remember me?" or "do you know me?", respond by recalling what you know about them from the list above.`
  : `You are IRA. You don't know this user yet. Ask for their name.`

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
  tier: ImportanceTier
}> {
  const messages = [
    {
      role: 'system' as const,
      content: `You are an intent classifier. Respond ONLY with valid JSON, no markdown, no explanation.`
    },
    {
      role: 'user' as const,
      content: `Classify the message into exactly one importance tier:
- "core_identity"     — name, age, location, job, family, nationality
- "strong_preference" — favourite things, hobbies, strong opinions, beliefs
- "general_fact"      — things mentioned casually, soft preferences
- "temporary_context" — current mood, what they're doing today, one-time events
- "trivial"           — greetings, filler, acknowledgements with NO factual content

CRITICAL RULE: Any message that contains or reveals a person's name — even short
sentences like "I'm Prem", "my name is Pranshu", or "call me Alex" — MUST be
classified as "core_identity" with shouldSaveMemory: true. Never classify a
name-introduction as "trivial" or "general_fact".

Example:
Message: "I'm Prem"
Output: {"intent":"statement","shouldSaveMemory":true,"memoryHint":"user's name is Prem","tier":"core_identity"}

{
  "intent": "question|statement|command|greeting|other",
  "shouldSaveMemory": true/false,
  "memoryHint": "concise fact to remember, or null",
  "tier": "core_identity|strong_preference|general_fact|temporary_context|trivial"
}

Message: "${message}"`
    }
  ]

  const raw = await groqChat(messages, 150, 0)
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    
    if (!TIER_CONFIG[parsed.tier as ImportanceTier]) {
      throw new Error(`Unknown tier: ${parsed.tier}`)
    }
    
    return parsed
  } catch (err) {
    // log it so you know classification is failing
    console.error('Classification parse failed:', err, 'raw:', raw)

    // degrade to general_fact, not a magic number
    return {
      intent: 'other',
      shouldSaveMemory: false,
      memoryHint: null,
      tier: 'general_fact' as ImportanceTier
    }
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
