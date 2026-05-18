export type SessionMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type Session = {
  history: SessionMessage[]
  lastActive: string
  adversarialStrikes?: number
  lastAdversarialAt?: number
}

export type ImportanceTier = 'core_identity' | 'strong_preference' | 'general_fact' | 'temporary_context' | 'trivial' | 'blocked'

export const TIER_CONFIG: Record<ImportanceTier, { importance: number; decayRate: number }> = {
  core_identity:      { importance: 0.9, decayRate: 0.01 },
  strong_preference:  { importance: 0.7, decayRate: 0.05 },
  general_fact:       { importance: 0.5, decayRate: 0.1  },
  temporary_context:  { importance: 0.3, decayRate: 0.3  },
  trivial:            { importance: 0.1, decayRate: 0.5  },
  blocked:            { importance: 0.0, decayRate: 1.0  },
}

export const TIER_RANK: Record<ImportanceTier, number> = {
  blocked:           -1,
  trivial:            0,
  temporary_context:  1,
  general_fact:       2,
  strong_preference:  3,
  core_identity:      4,
}