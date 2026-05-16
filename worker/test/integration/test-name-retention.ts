/**
 * Integration test: Name Retention after 2+ days of inactivity
 * Run: npx tsx worker/test/integration/test-name-retention.ts
 *
 * Covers 4 scenarios:
 *   S1 — CTE tier projection is live (Fix 1 sanity check)
 *   S2 — Real embedding similarity competition (actual failure case)
 *   S3 — Consolidation skips core_identity rows (Fix 2)
 *   S4 — Classifier always returns core_identity for name phrases (Fix 3)
 */

import path from 'path'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

// ─── project imports (adjust paths to match your structure) ──────────────────
import { getRelevantMemories }   from '../../src/memory/store'
import { classifyIntent }        from '../../src/chat'
import { consolidateMemories as runConsolidation } from '../../src/lib/consolidation'
import { embed as getEmbedding } from '../../src/gemini'
import { DECAY_SCORE_EXPR }      from '../../src/lib/decay'
import { initGroqKeys }          from '../../src/groq'
// ─────────────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') })

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL not found in .dev.vars')
  process.exit(1)
}

if (!process.env.GEMINI_API_KEY) {
  console.error('❌  GEMINI_API_KEY not found in .dev.vars')
  process.exit(1)
}

const DB_URL   = process.env.DATABASE_URL
const GEMINI_KEY = process.env.GEMINI_API_KEY
const sql      = neon(DB_URL)
const TEST_USER = 'test_retention_script'

// ─── types ───────────────────────────────────────────────────────────────────
interface ScenarioResult {
  name:     string
  passed:   boolean
  reason:   string
  expected: string
  actual:   string
}

const results: ScenarioResult[] = []

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Insert and automatically clean up after the test block */
async function withCleanUser(fn: () => Promise<void>): Promise<void> {
  await sql`DELETE FROM memories WHERE user_id = ${TEST_USER}`
  await sql`INSERT INTO users (id) VALUES (${TEST_USER}) ON CONFLICT DO NOTHING`
  try {
    await fn()
  } finally {
    await sql`DELETE FROM memories WHERE user_id = ${TEST_USER}`
  }
}

function record(
  name: string,
  passed: boolean,
  reason: string,
  expected: string,
  actual: string
) {
  const icon = passed ? '✅ PASS' : '❌ FAIL'
  console.log(`\n${icon}  ${name}`)
  if (!passed) {
    console.log(`  reason  : ${reason}`)
    console.log(`  expected: ${expected}`)
    console.log(`  actual  : ${actual}`)
  }
  results.push({ name, passed, reason, expected, actual })
}

/** Days-ago Date helper */
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — CTE tier projection sanity check
// ─────────────────────────────────────────────────────────────────────────────
async function scenario1() {
  console.log('\n──────────────────────────────────────────────')
  console.log('S1: CTE tier projection — does the rank bonus actually fire?')

  await withCleanUser(async () => {
    const twoDaysAgo = daysAgo(2)
    const nameEmb    = await getEmbedding(GEMINI_KEY, 'User name is Prem')
    const hobbyEmb   = await getEmbedding(GEMINI_KEY, 'User likes black coffee')

    // Both rows have identical importance / decay so the ONLY differentiator
    // is the 2× core_identity multiplier in ORDER BY.
    await sql`
      INSERT INTO memories
        (user_id, content, tier, importance, decay_rate, last_accessed, created_at, embedding)
      VALUES
        (${TEST_USER}, 'User name is Prem',      'core_identity', 0.5, 0.05,
         ${twoDaysAgo}, ${twoDaysAgo}, ${JSON.stringify(nameEmb)}::vector),
        (${TEST_USER}, 'User likes black coffee', 'general_fact',  0.5, 0.05,
         ${twoDaysAgo}, ${twoDaysAgo}, ${JSON.stringify(hobbyEmb)}::vector)
    `

    // Use a neutral query so similarity is ~equal for both rows
    const queryEmb = await getEmbedding(GEMINI_KEY, 'hello')
    const rows = await sql`
      WITH candidates AS (
        SELECT
          id, content, tier, importance,
          (1 - (embedding <=> ${JSON.stringify(queryEmb)}::vector)) AS similarity,
          ${sql.unsafe(DECAY_SCORE_EXPR())}                          AS decayed_importance
        FROM memories
        WHERE user_id = ${TEST_USER}
          AND is_archived = false
      )
      SELECT
        content,
        tier,
        decayed_importance,
        similarity,
        (similarity * decayed_importance *
          (CASE WHEN tier = 'core_identity' THEN 2.0 ELSE 1.0 END)) AS final_score
      FROM candidates
      ORDER BY final_score DESC
    `

    const top = rows[0]

    // If tier wasn't projected, the CASE defaults to 1.0 for everything
    // and the name would NOT reliably rank first.
    const passed  = top?.content === 'User name is Prem'
    const nameRow = rows.find(r => r.content === 'User name is Prem')
    const hobbyRow= rows.find(r => r.content === 'User likes black coffee')

    record(
      'S1 — CTE tier projection live',
      passed,
      passed ? '' : 'core_identity row did not rank first despite identical decay — tier column may not be projected',
      'top row = "User name is Prem"',
      `top row = "${top?.content}" | name_score=${nameRow?.final_score?.toFixed(4)} hobby_score=${hobbyRow?.final_score?.toFixed(4)}`
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — Real embedding competition (the actual production failure)
// ─────────────────────────────────────────────────────────────────────────────
async function scenario2() {
  console.log('\n──────────────────────────────────────────────')
  console.log('S2: Real embedding competition — name vs rich consolidated hobby summary')

  await withCleanUser(async () => {
    const twoDaysAgo = daysAgo(2)

    // The consolidated hobby summary is deliberately rich/long — this is what
    // beats the name memory in the unfixed version because it has a "richer"
    // embedding that matches more conversational contexts.
    const nameContent  = 'User name is Prem'
    const hobbyContent = 'User enjoys black coffee every morning, loves mangoes as their favourite fruit, prefers the colour blue, plays chess on weekends, and works as a software engineer'

    const nameEmb  = await getEmbedding(GEMINI_KEY, nameContent)
    const hobbyEmb = await getEmbedding(GEMINI_KEY, hobbyContent)

    await sql`
      INSERT INTO memories
        (user_id, content, tier, importance, decay_rate, last_accessed, created_at, embedding)
      VALUES
        (${TEST_USER}, ${nameContent},  'core_identity', 0.9, 0.01,
         ${twoDaysAgo}, ${twoDaysAgo}, ${JSON.stringify(nameEmb)}::vector),
        (${TEST_USER}, ${hobbyContent}, 'general_fact',  0.5, 0.1,
         ${twoDaysAgo}, ${twoDaysAgo}, ${JSON.stringify(hobbyEmb)}::vector)
    `

    // Greet the bot exactly as a returning user would — this is the query
    // where the rich hobby summary used to win the similarity contest.
    const memories = await getRelevantMemories(DB_URL, TEST_USER, await getEmbedding(GEMINI_KEY, 'Hey good morning'), 5)

    const nameInTop = memories.some(m => m.content === nameContent)
    const rank      = memories.findIndex(m => m.content === nameContent) + 1

    record(
      'S2 — Real embedding competition',
      nameInTop && rank === 1,
      nameInTop
        ? `name found but ranked #${rank} instead of #1`
        : 'name memory not in top-5 results at all',
      'name memory ranked #1',
      nameInTop
        ? `name ranked #${rank} of ${memories.length}`
        : `memories returned: ${memories.map(m => m.content.slice(0, 40)).join(' | ')}`
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — Consolidation must skip core_identity rows
// ─────────────────────────────────────────────────────────────────────────────
async function scenario3() {
  console.log('\n──────────────────────────────────────────────')
  console.log('S3: Consolidation skips core_identity — timestamps must not change')

  await withCleanUser(async () => {
    const threeDaysAgo = daysAgo(3)
    const nameEmb      = await getEmbedding(GEMINI_KEY, 'User name is Prem')
    const hobbyEmb     = await getEmbedding(GEMINI_KEY, 'User name is Prem and loves coffee') // near-duplicate

    // Insert core_identity memory with a known old timestamp
    await sql`
      INSERT INTO memories
        (user_id, content, tier, importance, decay_rate, last_accessed, created_at, embedding)
      VALUES
        (${TEST_USER}, 'User name is Prem', 'core_identity', 0.9, 0.01,
         ${threeDaysAgo}, ${threeDaysAgo}, ${JSON.stringify(nameEmb)}::vector),
        (${TEST_USER}, 'User is called Prem and loves coffee', 'general_fact', 0.5, 0.1,
         ${threeDaysAgo}, ${threeDaysAgo}, ${JSON.stringify(hobbyEmb)}::vector)
    `

    // Capture the exact timestamp before consolidation
    const [before] = await sql`
      SELECT last_accessed, created_at FROM memories
      WHERE user_id = ${TEST_USER} AND tier = 'core_identity'
    `

    // Run the nightly consolidation job
    await runConsolidation(DB_URL, GEMINI_KEY, TEST_USER)

    // Check row still exists and timestamps are unchanged
    const rows = await sql`
      SELECT content, tier, last_accessed, created_at FROM memories
      WHERE user_id = ${TEST_USER} AND tier = 'core_identity'
    `

    const stillExists    = rows.length === 1
    const tsUnchanged    = stillExists &&
      new Date(rows[0].last_accessed).getTime() === new Date(before.last_accessed).getTime()

    const passed = stillExists && tsUnchanged

    record(
      'S3 — Consolidation skips core_identity',
      passed,
      !stillExists   ? 'core_identity row was deleted or merged by consolidation' :
      !tsUnchanged   ? 'last_accessed was updated — decay clock was reset by consolidation' : '',
      'row exists & last_accessed unchanged',
      stillExists
        ? `row exists=${stillExists} | ts_unchanged=${tsUnchanged} | last_accessed=${rows[0]?.last_accessed}`
        : 'row not found after consolidation'
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — Classifier always returns core_identity for name phrases
// ─────────────────────────────────────────────────────────────────────────────
async function scenario4() {
  console.log('\n──────────────────────────────────────────────')
  console.log('S4: Classifier returns core_identity for all name phrasings × 3 runs each')

  const namePhrases = [
    "I'm Prem",
    'my name is Prem',
    'call me Prem',
    'Prem here',
    'btw I\'m Prem, nice to meet you',
  ]

  // Run each phrase 3 times to catch LLM non-determinism
  const RUNS = 3
  let allPassed = true
  const failures: string[] = []

  for (const phrase of namePhrases) {
    for (let run = 1; run <= RUNS; run++) {
      const result = await classifyIntent(phrase)
      if (result.tier !== 'core_identity') {
        allPassed = false
        failures.push(`"${phrase}" run ${run} → got "${result.tier}"`)
      }
    }
  }

  record(
    'S4 — Classifier core_identity for names',
    allPassed,
    allPassed ? '' : `${failures.length} misclassification(s) across ${namePhrases.length * RUNS} runs`,
    `all ${namePhrases.length * RUNS} classifications = core_identity`,
    allPassed
      ? `all ${namePhrases.length * RUNS} runs correct`
      : failures.join('\n         ')
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY TABLE
// ─────────────────────────────────────────────────────────────────────────────
function printSummary() {
  console.log('\n══════════════════════════════════════════════')
  console.log('SUMMARY')
  console.log('══════════════════════════════════════════════')

  const colW = [35, 8, 28, 28]
  const pad  = (s: string, w: number) => s.slice(0, w).padEnd(w)

  console.log(
    pad('Scenario', colW[0]) +
    pad('Result',   colW[1]) +
    pad('Expected', colW[2]) +
    pad('Actual',   colW[3])
  )
  console.log('─'.repeat(colW.reduce((a, b) => a + b, 0)))

  for (const r of results) {
    console.log(
      pad(r.name,                      colW[0]) +
      pad(r.passed ? '✅ PASS' : '❌ FAIL', colW[1]) +
      pad(r.expected,                  colW[2]) +
      pad(r.actual,                    colW[3])
    )
  }

  const passed = results.filter(r => r.passed).length
  console.log('─'.repeat(colW.reduce((a, b) => a + b, 0)))
  console.log(`\n${passed}/${results.length} scenarios passed`)

  if (passed < results.length) {
    console.log('\nFailed scenarios and reasons:')
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.reason}`)
    })
  }

  process.exit(passed === results.length ? 0 : 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Name Retention Integration Tests ===')
  console.log(`DB  : ${DB_URL.slice(0, 40)}...`)
  console.log(`User: ${TEST_USER}`)

  // Initialize Groq keys for Scenario 4
  initGroqKeys(
    process.env.GROQ_API_KEY_1 || '',
    process.env.GROQ_API_KEY_2 || ''
  )

  try {
    await scenario1()
    await scenario2()
    await scenario3()
    await scenario4()
  } catch (err) {
    // Hard crash — clean up and re-throw
    await sql`DELETE FROM memories WHERE user_id = ${TEST_USER}`.catch(() => {})
    console.error('\n💥 Unexpected error during test run:', err)
    process.exit(1)
  }

  printSummary()
}

main()
