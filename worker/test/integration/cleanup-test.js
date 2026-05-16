import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'
dotenv.config({ path: '.dev.vars' })

async function run() {
  const sql = neon(process.env.DATABASE_URL)
  const userId = '1045750629'

  console.log('Starting cleanup for user:', userId)

  // Wrong person entirely
  await sql`
    UPDATE memories 
    SET is_archived = true, archived_reason = 'manual'
    WHERE user_id = ${userId}
    AND content ILIKE '%prem%'
  `
  console.log('✅ Archived Prem rows')

  // Contradictory football rows — superseded by user's actual preference
  await sql`
    UPDATE memories 
    SET is_archived = true, archived_reason = 'superseded'
    WHERE user_id = ${userId}
    AND content ILIKE '%football%'
  `
  console.log('✅ Archived football rows')

  // Useless 'name' row with no value
  await sql`
    UPDATE memories 
    SET is_archived = true, archived_reason = 'manual'
    WHERE user_id = ${userId}
    AND content = 'name'
  `
  console.log('✅ Archived bare "name" row')

  // Duplicate cricket rows — keep newest only
  await sql`
    UPDATE memories 
    SET is_archived = true, archived_reason = 'superseded'
    WHERE user_id = ${userId}
    AND content = 'user likes cricket'
    AND created_at < '2026-05-16T14:36:00'
  `
  console.log('✅ Archived duplicate cricket rows')

  await sql`
  UPDATE memories
  SET is_archived = true, archived_reason = 'superseded'
  WHERE user_id = ${userId}
  AND content = 'name: pranshu'
`

  // Verify what's left
  const active = await sql`
    SELECT content, tier, importance, created_at
    FROM memories
    WHERE user_id = ${userId}
    AND is_archived = false
    ORDER BY tier, created_at DESC
  `
  console.log('\nActive memories after cleanup:')
  console.table(active)
}

run().catch(console.error)