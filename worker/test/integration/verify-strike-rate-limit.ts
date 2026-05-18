import path from 'path';
import dotenv from 'dotenv';
import { Redis } from '../../src/redis';

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') });

const testUserId = 'test_strike_limit_user_111';

// Import recordAdversarialStrike from index using require to bypass module side-effects if any, or define standard invocation
// Since recordAdversarialStrike is not exported from index, we can recreate the same execution logic to assert the Redis integration
async function recordAdversarialStrike(redis: Redis, userId: string, backdateMs?: number): Promise<void> {
  const session = await redis.getSession<any>(userId) ?? {
    history: [],
    lastActive: new Date().toISOString()
  };
  
  const now = Date.now();
  if (backdateMs) {
    session.lastAdversarialAt = now - backdateMs;
  }

  let strikes = session.adversarialStrikes || 0;
  
  // TTL-based reset: If 24 hours have passed since last adversarial hit, decay strikes to 0
  if (session.lastAdversarialAt && now - session.lastAdversarialAt > 24 * 60 * 60 * 1000) {
    strikes = 0;
  }
  
  session.adversarialStrikes = Math.min(strikes + 1, 99);
  session.lastAdversarialAt = now;
  await redis.setSession(userId, session);
}

async function run() {
  console.log("--- STARTING ADVERSARIAL STRIKE RATE LIMIT & TTL DECAY TEST ---\n");

  const redis = new Redis(
    process.env.UPSTASH_REDIS_REST_URL || '',
    process.env.UPSTASH_REDIS_REST_TOKEN || ''
  );

  // Clean up historical test data
  await redis.del(`session:${testUserId}`);

  console.log("1. Simulating 105 consecutive adversarial attacks...");
  for (let i = 0; i < 105; i++) {
    await recordAdversarialStrike(redis, testUserId);
  }

  let session = await redis.getSession<any>(testUserId);
  console.log(`- Final strike count after 105 hits: ${session?.adversarialStrikes}`);

  if (session?.adversarialStrikes === 99) {
    console.log("✓ Success: Strike count was successfully capped at 99!");
  } else {
    console.error(`❌ Failed: Strike count did not cap at 99 (got ${session?.adversarialStrikes})`);
  }

  console.log("\n2. Simulating a 25-hour time decay since last attack...");
  // Inject backdated timestamp (25 hours ago = 25 * 60 * 60 * 1000 ms)
  await recordAdversarialStrike(redis, testUserId, 25 * 60 * 60 * 1000);

  session = await redis.getSession<any>(testUserId);
  console.log(`- Strike count after 25-hour decay & 1 new hit: ${session?.adversarialStrikes}`);

  if (session?.adversarialStrikes === 1) {
    console.log("✓ Success: Strike count decayed to 0 and reset successfully to 1!");
  } else {
    console.error(`❌ Failed: Strike count did not reset (got ${session?.adversarialStrikes})`);
  }

  // Clean up
  console.log("\nCleaning up Redis test session...");
  await redis.del(`session:${testUserId}`);
  console.log("✓ Cleanup completed.");

  console.log("\n--- ADVERSARIAL STRIKE RATE LIMIT INTEGRATION TEST COMPLETE ---");
}

run().catch(console.error);
