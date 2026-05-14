import path from 'path';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { DECAY_SCORE_EXPR } from '../../src/lib/decay';

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') });

if (!process.env.DATABASE_URL) {
  console.error(" Error: DATABASE_URL not found in .dev.vars");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function testSpacedRepetition() {
  console.log("--- SPACED REPETITION DECAY TEST ---\n");

  const userId = 'test_spaced_rep_user';
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 30);

  await sql`INSERT INTO users (id, platform) VALUES (${userId}, 'test') ON CONFLICT DO NOTHING`;

  const mockEmbedding = JSON.stringify(new Array(768).fill(0).map(() => Math.random()));

  const [mem1] = await sql`
    INSERT INTO memories (user_id, content, importance, decay_rate, last_accessed, access_count, embedding)
    VALUES (${userId}, 'rarely accessed memory', 0.5, 0.1, ${oldDate.toISOString()}, 1, ${mockEmbedding}::vector)
    RETURNING id
  `;

  const [mem2] = await sql`
    INSERT INTO memories (user_id, content, importance, decay_rate, last_accessed, access_count, embedding)
    VALUES (${userId}, 'frequently accessed memory', 0.5, 0.1, ${oldDate.toISOString()}, 50, ${mockEmbedding}::vector)
    RETURNING id
  `;

  const scores = await sql`
    SELECT
      content,
      access_count,
      ROUND((${sql.unsafe(DECAY_SCORE_EXPR())})::numeric, 6) AS decay_score
    FROM memories
    WHERE user_id = ${userId}
    ORDER BY decay_score DESC
  `;

  console.log("Decay scores after 30 days:\n");
  scores.forEach(row => {
    console.log(`  "${row.content}"`);
    console.log(`  access_count: ${row.access_count}`);
    console.log(`  decay_score:  ${row.decay_score}\n`);
  });

  const frequently = scores.find(r => r.access_count === 50);
  const rarely     = scores.find(r => r.access_count === 1);

  if (parseFloat(frequently.decay_score) > parseFloat(rarely.decay_score)) {
    console.log("✓ Spaced repetition working: frequently accessed memory has higher survival score.");
  } else {
    console.error("❌ Failed: access_count is not affecting decay.");
  }

  await sql`DELETE FROM memories WHERE user_id = ${userId}`;
  console.log("✓ Cleanup complete.");
}

testSpacedRepetition().catch(console.error);
