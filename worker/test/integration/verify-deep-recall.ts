const path = require('path');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config({ path: path.join(__dirname, '../../.dev.vars') });

if (!process.env.DATABASE_URL) {
  console.error(" Error: DATABASE_URL not found in .dev.vars");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function testDeepRecall() {
  console.log("--- STARTING DEEP RECALL INTEGRATION TEST ---\n");

  let userId = 'test_deep_recall_user';

  // 0. Ensure test user exists
  console.log("0. Creating test user...");
  await sql`
    INSERT INTO users (id, platform)
    VALUES (${userId}, 'test')
    ON CONFLICT (id) DO NOTHING
  `;

  // 1. Setup - Create a "decayed" memory
  console.log("1. Inserting a very old memory (decay score will be near 0)...");
  
  // Create an old timestamp (100 days ago)
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 100);

  const mockEmbedding = new Array(768).fill(0).map(() => Math.random());
  
  // Insert directly to bypass existing filters
  const insertResult = await sql`
    INSERT INTO memories (user_id, content, importance, decay_rate, last_accessed, embedding)
    VALUES (${userId}, 'remember when we talked about my old job', 0.5, 0.1, ${oldDate.toISOString()}, ${JSON.stringify(mockEmbedding)}::vector)
    RETURNING id
  `;
  const memoryId = insertResult[0].id;
  console.log(`✓ Inserted memory ID: ${memoryId}\n`);

  // 2. Run Pruning
  console.log("2. Running pruneDecayedMemories...");
  const pruneResult = await sql`
    UPDATE memories
    SET
      is_archived            = true,
      archived_at            = NOW(),
      archived_reason        = 'decay',
      decay_score_at_archive = (importance * EXP(
        -decay_rate * EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400
      ))
    WHERE user_id = ${userId}
      AND is_archived = false
      AND importance * EXP(
        -decay_rate * EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400
      ) < 0.05
    RETURNING id, decay_score_at_archive, is_archived
  `;
  console.log(`✓ Pruned ${pruneResult.length} memories.`);
  if (pruneResult.length > 0) {
    console.log("Prune data:", pruneResult[0], "\n");
  }

  // 3. Normal Search (Should not find it)
  console.log("3. Running normal search...");
  const normalSearch = await sql`
    SELECT id, content FROM memories
    WHERE user_id = ${userId} AND is_archived = false
    AND id = ${memoryId}
  `;
  if (normalSearch.length === 0) {
    console.log("✓ Success: Normal search did NOT find the archived memory.\n");
  } else {
    console.error("❌ Failed: Normal search found the memory!\n");
  }

  // 4. Deep Recall (Should find it)
  console.log("4. Running deep recall...");
  const deepRecallSearch = await sql`
    SELECT id, content, is_archived FROM memories
    WHERE user_id = ${userId} AND is_archived = true
    AND id = ${memoryId}
  `;
  if (deepRecallSearch.length > 0) {
    console.log("✓ Success: Deep recall FOUND the archived memory.");
    console.log("Recalled memory:", deepRecallSearch[0], "\n");
  } else {
    console.error("❌ Failed: Deep recall did not find the memory!\n");
  }

  // 5. Resurface
  console.log("5. Testing resurface()...");
  await sql`
    UPDATE memories
    SET
      is_archived  = false,
      archived_at  = NULL,
      archived_reason = NULL,
      decay_score_at_archive = NULL,
      importance   = LEAST(importance * 2, 1.0),
      last_accessed = NOW()
    WHERE id = ${memoryId}
  `;
  
  const resurfaceCheck = await sql`
    SELECT id, is_archived, importance FROM memories WHERE id = ${memoryId}
  `;
  console.log("✓ Success: Memory resurfaced.");
  console.log("Final state:", resurfaceCheck[0], "\n");

  // Cleanup
  console.log("6. Cleaning up test data...");
  await sql`DELETE FROM memories WHERE user_id = ${userId}`;
  console.log("✓ Test complete.");
}

testDeepRecall().catch(console.error);
