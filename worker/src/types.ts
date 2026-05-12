export type SessionMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type Session = {
  history: SessionMessage[]
  lastActive: string
}