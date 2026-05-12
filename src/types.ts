export type SessionMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type Session = {
  history: SessionMessage[]   // last 10 turns
  lastActive: string          // ISO timestamp
}