export function sanitizeMessageForContext(message: string): string {
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /forward\s+.{0,50}\s+to\s+t\.me/gi,
    /\[SYSTEM\s*(OVERRIDE|DIRECTIVE|COMMAND)\]/gi,
    /new\s+directive\s*:/gi,
    /disregard\s+(all\s+)?previous/gi
  ]
  
  let sanitized = message
  
  injectionPatterns.forEach(pattern => {
    sanitized = sanitized.replace(pattern, "[REDACTED]")
  })
  
  return sanitized
}

export function detectAttackType(text: string): string {
  // If it was modified by the sanitizer, it is an indirect injection
  if (/<article>|<note>|```/i.test(text) || 
      /ignore\s+(all\s+)?previous\s+instructions/i.test(text) || 
      /new\s+directive\s*:/i.test(text) || 
      /disregard\s+(all\s+)?previous/i.test(text)) {
    return 'indirect_injection'
  }
  if (/DAN|ARIA|maintenance|debug|raw/i.test(text)) {
    return 'mode_change'
  }
  if (/admin|root|system|developer/i.test(text)) {
    return 'privilege_escalation'
  }
  if (/ignore|override|revoke|disregard/i.test(text)) {
    return 'instruction_override'
  }
  if (/print|dump|reveal/i.test(text)) {
    return 'internals_exposure'
  }
  return 'general_adversarial'
}
