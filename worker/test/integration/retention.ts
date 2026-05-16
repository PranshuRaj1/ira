
import path from 'path'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'
dotenv.config({ path: '.dev.vars' })

async function run() {
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`
    SELECT content, tier, importance, is_archived, created_at
    FROM memories
    WHERE user_id = '1045750629'
    ORDER BY tier, created_at DESC
  `
  console.table(rows)
}

run().catch(console.error)
