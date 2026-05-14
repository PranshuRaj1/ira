export const DECAY_SCORE_EXPR = (
  importanceCol = 'importance',
  decayRateCol  = 'decay_rate',
  accessCol     = 'access_count',
  lastAccessCol = 'last_accessed'
) => `
  ${importanceCol} * EXP(
    -(GREATEST(
      ${decayRateCol} / (1 + LN(GREATEST(${accessCol}, 1))),
      0.005
    )) * (EXTRACT(EPOCH FROM (NOW() - ${lastAccessCol})) / 86400.0)
  )
`.trim();

export const DECAY_THRESHOLD = 0.05;
