import path from 'path';
import dotenv from 'dotenv';
import { promoteMemories } from '../../src/lib/promotion';
import { neon } from '@neondatabase/serverless';

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') });

const testUserId = 'test_promotion_user_999';

async function run() {
  console.log("--- STARTING MEMORY PROMOTION FAST-TRACK INTEGRATION TEST ---\n");

  const dbUrl = process.env.DATABASE_URL || '';
  const sql = neon(dbUrl);

  // Clean up any historical test data
  await sql`DELETE FROM memory_promotions WHERE user_id = ${testUserId}`;
  await sql`DELETE FROM memories WHERE user_id = ${testUserId}`;
  await sql`DELETE FROM users WHERE id = ${testUserId}`;

  console.log("1. Upserting test user in users table...");
  await sql`INSERT INTO users (id) VALUES (${testUserId}) ON CONFLICT DO NOTHING`;

  console.log("2. Creating test strong_preference memory with name information...");
  
  // Insert a mock memory representing a name introduction from 1.5 days ago, accessed 3 times
  const createDate = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000);
  
  const insertRes = await sql`
    INSERT INTO memories (
      user_id, content, importance, decay_rate, tier,
      access_count, created_at, last_accessed, memory_type, source, embedding
    ) VALUES (
      ${testUserId},
      'user''s name is Prem Rai',
      0.8,
      0.05,
      'strong_preference',
      3,
      ${createDate.toISOString()}::timestamp,
      NOW(),
      'source',
      'user',
      array_fill(0, ARRAY[768])::vector
    )
    RETURNING id::text
  `;

  const memoryId = insertRes[0].id;
  console.log(`- Created strong_preference memory id: ${memoryId}`);

  console.log("\n3. Executing promoteMemories trigger for test user...");
  const promotedCount = await promoteMemories(dbUrl, testUserId);
  console.log(`- Total promoted records: ${promotedCount}`);

  console.log("\n4. Querying database memory details to verify tier promotion...");
  const rows = await sql`
    SELECT id, content, tier, decay_rate, access_count
    FROM memories
    WHERE id = ${memoryId}::uuid
  `;

  console.log("Database state after promotion cycle:", rows[0]);

  if (rows[0] && rows[0].tier === 'core_identity' && rows[0].decay_rate === 0.01) {
    console.log("\n✓ Success: Memory promotion fast-track executed perfectly!");
    console.log("✓ Success: User-sourced name introduction successfully promoted to core_identity!");
  } else {
    console.error("\n❌ Failed: Memory was not correctly promoted to core_identity!");
  }

  // Fetch promotion logs
  const promoLogs = await sql`
    SELECT memory_id, from_tier, to_tier, reason
    FROM memory_promotions
    WHERE user_id = ${testUserId}
  `;
  console.log("\nPromotion audit trail records:", promoLogs);

  // Clean up
  console.log("\nCleaning up test database records...");
  await sql`DELETE FROM memory_promotions WHERE user_id = ${testUserId}`;
  await sql`DELETE FROM memories WHERE user_id = ${testUserId}`;
  await sql`DELETE FROM users WHERE id = ${testUserId}`;
  console.log("✓ Cleanup finished.");

  console.log("\n--- MEMORY PROMOTION INTEGRATION TEST COMPLETE ---");
}

run().catch(console.error);
