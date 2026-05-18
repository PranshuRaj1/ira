import path from 'path';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.dev.vars') });

if (!process.env.DATABASE_URL) {
  console.error(" Error: DATABASE_URL not found in .dev.vars");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log("--- RUNNING DATABASE MIGRATION ---");
  
  console.log("Executing: ALTER TABLE memories ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user'...");
  await sql`
    ALTER TABLE memories 
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user'
  `;
  
  console.log("Executing: CREATE TABLE IF NOT EXISTS security_log...");
  await sql`
    CREATE TABLE IF NOT EXISTS security_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      attack_type TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  console.log("Executing: CREATE TABLE IF NOT EXISTS suspicious_memory_attempts...");
  await sql`
    CREATE TABLE IF NOT EXISTS suspicious_memory_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      memory_hint TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  console.log("Executing: CREATE TABLE IF NOT EXISTS memory_promotions...");
  await sql`
    CREATE TABLE IF NOT EXISTS memory_promotions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      access_count INTEGER NOT NULL,
      reason TEXT NOT NULL,
      promoted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  console.log("✓ Migration query completed successfully.");
}

migrate().catch(console.error);
