import path from 'path';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { DECAY_SCORE_EXPR } from '../../src/lib/decay';

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') });

if (!process.env.DATABASE_URL) {
  console.error(" Error: DATABASE_URL not found in .dev.vars");
  console.log("Current directory:", process.cwd());
  console.log("Script directory:", __dirname);
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function verify() {
  let userId = '12345'; // Placeholder
  
  // Auto-detect a real user if possible
  const users = await sql`SELECT id FROM users LIMIT 1`;
  if (users.length > 0) {
    userId = users[0].id;
    console.log(`Using auto-detected User ID: ${userId}`);
  } else {
    console.warn(" No users found in database. Script will likely return empty results.");
  }

  // Mock embedding (768 dimensions for Gemini)
  const queryEmbedding = new Array(768).fill(0).map(() => Math.random());

  console.log("--- DEBUGGING DECAY RANKING ---");
  
  const results = await sql`
    WITH candidates AS (
      SELECT
        id, content, importance, last_accessed, access_count,
        (1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector)) AS similarity,
        ${sql.unsafe(DECAY_SCORE_EXPR())} AS decayed_importance
      FROM memories
      WHERE user_id = ${userId}
      AND is_archived = false
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 50
    )
    SELECT 
      content, 
      similarity, 
      decayed_importance, 
      (similarity * decayed_importance) as final_score
    FROM candidates
    ORDER BY final_score DESC
    LIMIT 5;
  `;

  console.table(results);
}

verify().catch(console.error);


/*
content          : 'user likes coffee'
similarity       : 0.87   — how relevant to the query (1.0 = perfect match)
decayed_importance: 0.31  — how fresh/important the memory is right now
final_score      : 0.27   — combined score (similarity × decayed_importance)
*/