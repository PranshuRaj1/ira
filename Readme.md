# IRA — Intelligent Retrieval Assistant

> A memory-augmented AI bot that actually remembers you — built on Cloudflare Workers, Neon PostgreSQL (pgvector), Upstash Redis, and a three-layer cognitive pipeline.

**Talk to IRA on Telegram:** [@ira_memory_bot](http://t.me/ira_memory_bot)  
**Dashboard (internal):** [ira-dashboard.pages.dev](https://ira-dashboard.pages.dev/)

Built by [Pranshu Raj](https://github.com/PranshuRaj1). Read the [IRA architecture and debugging case study](https://pranshuraj.vercel.app/projects/ira) on the portfolio.

---

## Table of Contents

1. [What Is IRA?](#1-what-is-ira)
2. [The Three-Layer Cognitive Pipeline](#2-the-three-layer-cognitive-pipeline)
3. [Graceful Degradation via Latency Budgets](#3-graceful-degradation-via-latency-budgets)
4. [Vector Search — Why HNSW over IVFFlat](#4-vector-search--why-hnsw-over-ivfflat)
5. [The Memory Decay Formula](#5-the-memory-decay-formula)
6. [Memory Tiers](#6-memory-tiers)
7. [Memory Consolidation](#7-memory-consolidation)
8. [Deep Recall](#8-deep-recall)
9. [Infrastructure Decisions](#9-infrastructure-decisions)
10. [Database Schema](#10-database-schema)
11. [Metrics](#11-metrics)
12. [Running Locally](#12-running-locally)

---

## 1. What Is IRA?

Most AI chatbots are stateless. Every conversation starts from zero. You could tell ChatGPT your name today and it will not know it tomorrow.

IRA is designed to fix that. It builds a **long-term, decaying, retrieval-augmented memory** for each user. It learns facts over time, weights them by importance and recency, forgets things you stop referencing, and consolidates related fragments into richer summaries. The goal is a bot that feels like it actually knows you.

---

## 2. The Three-Layer Cognitive Pipeline

### Why not one big LLM call?

The naive approach is: take the message, retrieve some memories, throw it all into one prompt, get a response. That works. But it creates a single point of failure, makes latency unpredictable, and makes debugging nearly impossible when something goes wrong.

IRA separates concerns into three layers that mirror how a human assistant thinks:

1. **Understand the request** → Peek
2. **Recall relevant context** → Mesh
3. **Formulate a response** → Silk

Peek and Mesh run **in parallel**. Silk waits for both. Total latency is `max(Peek, Mesh) + Silk`, not `Peek + Mesh + Silk`. This is the core architectural decision.

---

### Peek — Intent Classification

**Question it answers:** *"What is this message about and is it worth remembering?"*

**Model:** `llama-3.3-70b-versatile` via Groq (fast LPU inference, structured JSON output)  
**Latency:** ~50–100ms (pure inference, zero DB work)

Peek reads the incoming message and returns a structured decision:

```json
{
  "intent": "statement",
  "shouldSaveMemory": true,
  "memoryHint": "user's name is Pranshu and loves chess",
  "tier": "core_identity"
}
```

**Why it matters beyond classification:** Peek acts as a gatekeeper. If `shouldSaveMemory` is `false`, the entire embedding + write pipeline is skipped. This means greetings ("hey", "ok", "lol") never touch the database. This is a real cost and latency saving, not a minor optimization.

**Peek also assigns the importance tier.** "My name is Pranshu" gets `core_identity`. "I'm bored today" gets `temporary_context`. This tier flows downstream and controls how fast that memory decays.

**Fallback behavior:** If Peek times out or the circuit breaker is open, a safe fallback (`shouldSaveMemory: false, intent: 'other'`) is returned. The pipeline continues without memory saving. The user sees no failure.

---

### Mesh — Memory Retrieval

**Question it answers:** *"What do I already know about this user that's relevant right now?"*

**Stack:** Gemini `gemini-embedding-2` (768-dim) + Neon pgvector cosine similarity  
**Latency:** ~400–800ms (Gemini embedding call + Neon HTTP round-trip)

Mesh converts the current message into a 768-dimensional vector, runs a cosine similarity search against the user's memory store, re-ranks results by **decayed importance** (not raw similarity), and returns the top 5 memories.

```
Input: "What should I play today?"

Retrieved memories:
  "user loves chess"        → decayed_importance: 0.87
  "user plays on weekends"  → decayed_importance: 0.61
```

**Why 768 dimensions?**

Gemini's embedding model outputs 768-dim vectors. This is a deliberate middle ground:
- 384-dim (MiniLM-class): faster, cheaper, but loses semantic nuance on ambiguous inputs
- 1536-dim (OpenAI ada-002-class): more expressive, but 2× storage cost and API overhead
- 768-dim: good semantic coverage, 3KB per vector row, practical for a personal memory store

**Re-ranking by decayed importance, not raw similarity:** A memory retrieved by pure cosine similarity might be semantically close but already faded (low decayed importance). Sorting by `similarity × decayed_importance` ensures old, stale memories don't crowd out recent, relevant ones.

---

### Silk — Response Generation

**Question it answers:** *"What should I say back?"*

**Model:** `llama-3.3-70b-versatile` via Groq  
**Latency:** ~800–1200ms (full LLM generation)

Silk waits for both Peek and Mesh to resolve, then combines:
- The user's current message
- Up to 5 retrieved memories from Mesh
- The last 10 turns of conversation history from Redis

It sends all of this to Groq and generates the response.

**Why Groq for generation?** Groq's LPU hardware provides consistent token generation speed, not just fast time-to-first-token. For a conversational bot where response latency is a direct product experience, sub-1200ms end-to-end is achievable with Groq in a way that most hosted providers cannot match at the same price point.

---

## 3. Graceful Degradation via Latency Budgets

This is the most important production concern that gets ignored in demo projects.

### The problem

Mesh is the slowest layer. It calls an external embedding API (Gemini) and then hits a database. Under normal conditions it takes 400–800ms. But external APIs have tail latencies. At the p99, Gemini might take 2 seconds. If Silk waits indefinitely for Mesh, the user gets a dead bot during these windows.

### Solution: hard latency budgets

Every layer runs inside `withTimeout()`. If the layer does not resolve within its budget, a safe fallback is returned immediately.

```
PEEK_LAYER:  1000ms
MESH_LAYER:   800ms
SILK_LAYER:  3000ms
TELEGRAM:    2000ms
```

```
t = 0ms     Peek + Mesh start in parallel
t = 80ms    Peek resolves → intent classified
t = 800ms   Mesh budget expires (hard deadline)
            Silk proceeds with whatever Mesh returned by now

If Mesh returned results:  full personalized response
If Mesh timed out:         generic response, no memory context
```

A slightly less personalized response in under a second is better than a perfect response that takes 3 seconds or never arrives. That is a deliberate product decision.

### Circuit breaker

In addition to per-call timeouts, IRA uses a Redis-backed circuit breaker. If Groq or Gemini fails 5 consecutive times, the breaker trips for 60 seconds. All calls to that service return the fallback immediately without wasting network time. State is stored in Upstash Redis so it persists across Cloudflare Worker isolate restarts.

```typescript
// timeKey written BEFORE incr — partial crash leaves circuit closed (safe)
await this.redis.setRaw(this.timeKey, String(Date.now()), 3600)
const failures = await this.redis.incr(this.failKey, 3600)
```

The ordering is intentional: if the worker crashes between the two writes, `failKey` stays at 0 and the circuit stays closed. The dangerous alternative (increment first) would leave `failKey` incremented with `timeKey` at 0, causing `isOpen()` to immediately reset the circuit on every check — silently breaking the trip logic.

### Asynchronous write path

Memory writes happen **after the response is sent**, not before.

```
1. Peek: "this is worth saving as core_identity"
2. Silk: generate and send response immediately → user gets reply
3. [after response, inside waitUntil()] → embed memoryHint → write to Neon
```

`c.executionCtx.waitUntil()` in Cloudflare Workers keeps the isolate alive after the HTTP response is returned. The write pipeline runs in the background. From the user's perspective, memory persistence has zero latency cost.

---

## 4. Vector Search — Why HNSW over IVFFlat

Both are approximate nearest neighbor (ANN) index types available in pgvector. The choice is significant.

### What HNSW actually is

HNSW (Hierarchical Navigable Small World) builds a multi-layered graph over your vectors. Each layer is a sparser subset of the one below, with fewer nodes but longer-range connections. Search starts at the top (sparse, fast to traverse), finds an approximate nearest neighbor, then descends to lower layers for refinement.

```
Layer 2 (sparse):    A ─────────────────→ E
                          \
Layer 1:              A ──→ C ──────────→ E ──→ G
                                \
Layer 0 (full):       A → B → C → D → E → F → G
```

During search, you navigate greedily — always moving to the neighbor closer to the query vector. The hierarchical structure means you skip the vast majority of the dataset entirely.

**Properties:**
| Property | Value |
|---|---|
| Query time | O(log N) approximately |
| Build time | O(N log N) |
| Memory | Higher than IVFFlat (graph structure lives in memory) |
| Minimum rows needed | 1 (works at any scale) |
| Recall accuracy | Higher than IVFFlat at equivalent speed |

### Why not IVFFlat?

IVFFlat clusters all vectors into `lists` buckets at build time. At query time, it searches only the nearest `probes` buckets. Fast and memory-efficient — but it needs **at least 1000 rows** before the cluster centroids are meaningful. Below that threshold, recall drops badly because the centroid placement is noise.

HNSW degrades gracefully from 1 row to 1 million rows. For a project with a growing user base, this is the correct default.

> IVFFlat becomes worth reconsidering at 500k+ rows where HNSW's higher memory footprint starts to matter at scale.

**Index in use:**
```sql
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
```

`vector_cosine_ops` means distance is measured by cosine similarity. Since Gemini embeddings are normalized, cosine similarity is equivalent to dot product, which is the cheapest vector operation available.

---

## 5. The Memory Decay Formula

### The Ebbinghaus Forgetting Curve

Human memory follows an exponential decay pattern documented by Hermann Ebbinghaus in 1885. Without reinforcement, retained knowledge drops sharply at first, then levels off. Each successful recall "resets" the decay clock and increases memory stability.

```
R = e^(−t / S)
```

Where `R` is retention, `t` is time elapsed, and `S` is stability (which grows with each recall).

### The first attempt (and its problems)

```sql
importance * EXP(
  -(decay_rate / (1 + LN(GREATEST(access_count, 1))))
  * days_since_last_accessed
)
```

More recalls → slower decay. The logarithm grows fast at first then flattens — mirroring how spaced repetition actually works: the 2nd recall matters a lot, the 200th recall makes a small additional difference.

**Problem 1:** At `access_count = 1`, `LN(1) = 0`, so the divisor is `1 + 0 = 1`. The first recall provides no stability boost. Psychologically accurate, but it should be a deliberate design choice, not an accident.

**Problem 2:** At `access_count = 100,000`, `LN(100000) = 11.5`, making the effective decay rate approach near-zero. Memories become accidentally immortal as a side effect of access count, not by explicit design. You probably want permanence to be a deliberate choice.

### The corrected formula — with a minimum decay floor

```sql
importance * EXP(
  -(GREATEST(
    decay_rate / (1 + LN(GREATEST(access_count, 1))),
    0.005
  ))
  * (EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 86400.0)
)
```

`GREATEST(..., 0.005)` adds a **minimum effective decay rate**. Even the most-recalled memory will eventually fade without interaction.

```
At floor = 0.005:
  e^(-0.005 × 200) = 0.37  →  drops to 37% after 200 days
  e^(-0.005 × 530) ≈ 0.07  →  effectively archived after ~18 months
```

**Tuning the floor:**

| Floor | Practical memory horizon |
|---|---|
| 0.001 | ~7 years |
| 0.005 | ~18 months ← IRA default |
| 0.01 | ~9 months |
| 0.02 | ~4 months |

**Archive threshold:** `DECAY_THRESHOLD = 0.05`. When a memory's decayed score falls below 5% of its original importance, it is soft-archived — not hard deleted.

---

## 6. Memory Tiers

Peek classifies every saveable message into one of five tiers. The tier controls both the starting importance and the decay rate.

| Tier | Starting Importance | Decay Rate / Day | Example |
|---|---|---|---|
| `core_identity` | 0.9 | 0.01 | Name, age, location, job |
| `strong_preference` | 0.7 | 0.05 | Favourite things, strong opinions |
| `general_fact` | 0.5 | 0.10 | Casual mentions, soft preferences |
| `temporary_context` | 0.3 | 0.30 | Current mood, what they're doing today |
| `trivial` | 0.1 | 0.50 | Greetings, filler, acknowledgements |

**Why tier-based decay instead of a single formula?**

A user's name should survive 3 years of inactivity. Their current mood should be gone by tomorrow. A flat decay formula can't express that. Tiers let each memory carry its own half-life.

**Deferred promotion:** Tier is not fixed at write time forever. A `general_fact` that gets accessed 20+ times over 30+ days is promoted to `strong_preference` by the nightly sleep cycle job. A `strong_preference` accessed 50+ times over 90+ days is promoted to `core_identity`. Promotion resets the decay rate to the new tier's rate. This means memories earn their durability through actual usage patterns, not just initial classification.

---

## 7. Memory Consolidation

As a user interacts over months, the `memories` table accumulates many small related facts. Without consolidation, Mesh's top-5 results could be entirely dominated by chess memories, crowding out other important context.

Consolidation is the nightly process of merging semantically similar memories into richer, more compact summaries.

### How it works

1. **Candidate selection:** Fetch memories with `access_count >= MIN_ACCESS_COUNT` and last accessed within the consolidation window. Use `FOR UPDATE SKIP LOCKED` to prevent two concurrent cron jobs from processing the same rows.

2. **Clustering:** Group candidates by cosine similarity (threshold ~0.85). Memories within a cluster are semantically close enough to be merged.

3. **Synthesis:** Send each cluster to Groq (low temperature, `t=0.1` for stability). The LLM produces a single merged summary, assigns a tier, and returns a confidence score.

4. **Confidence gating:** If `confidence < MIN_CONFIDENCE`, skip the cluster entirely. Contradictory memories (e.g., "user lives in Delhi" + "user lives in Mumbai") produce low confidence and are not merged incorrectly.

5. **Atomic write:** In a single transaction:
   - Insert the consolidated memory with `memory_type = 'consolidated'` and `source_memory_ids`
   - Archive source memories with `archived_reason = 'consolidated'`
   - The consolidated summary gets a **real embedding** so it remains retrievable by vector search

6. **Rollback support:** A `rollbackConsolidation(consolidationId)` function unarchives sources and deletes the consolidated row in one transaction — used if a synthesis produces a bad result.

**Cosine similarity** measures the angle between two vectors. If two memories encode semantically similar ideas, their embeddings point in nearly the same direction — cosine similarity approaches 1.0. This is the mathematical foundation for identifying merge candidates.

---

## 8. Deep Recall

Standard Mesh retrieval is optimized for the current conversation context: embed the current message, find the most similar memories. This is correct for most queries.

But when a user asks "what do you know about me?" or "what have we talked about before?", cosine similarity against those words returns memories semantically close to the phrase "what do you know about me" — which is unhelpful.

**Deep recall** is a secondary retrieval path triggered when Peek classifies the intent as retrospective:

1. Skip embedding similarity entirely
2. Load memories sorted by `(access_count DESC, importance DESC)` — the most significant memories overall
3. Group by tier
4. Return a structured profile rather than a flat ranked list

This intentional divergence from the standard Mesh path is what makes the feature feel correct to the user.

**Resurfacing:** When a deep recall retrieves an archived memory, it is automatically resurfaced — `is_archived` flipped to false, `importance` boosted (`LEAST(importance * 2, 1.0)`), `access_count` incremented. The memory re-enters the active pool as if it had just been recalled.

---

## 9. Infrastructure Decisions

### Cloudflare Workers + Neon HTTP Driver

Cloudflare Workers run inside a V8 isolate, **not** a real Node.js environment. The standard `pg` library requires a TCP socket, which V8 isolates do not support. Neon provides an HTTP wrapper:

```
your code → fetch() → Neon HTTP endpoint → Neon proxy → Postgres
```

The `sql` tag from `@neondatabase/serverless` is literally a `fetch()` call under the hood. Workers can `fetch()`. That is the entire reason for this choice.

**The trade-off:** HTTP-per-query has higher per-request overhead than a persistent connection pool. For a chatbot where each conversation turn makes 1–2 DB round-trips, this overhead is negligible. For a high-frequency write workload (thousands of queries per second), you would reconsider and use a connection pooler like PgBouncer with a persistent connection.

### Upstash Redis for Conversation History and Circuit State

Conversation history (the last N turns) is stored in Redis, not Postgres.

**Why Redis for history?**
- Access pattern: always fetched by a single key (`user_id`), always fully loaded, never partially queried
- Natural TTL: you don't need 6-month-old history for the current turn
- Redis `GET`/`SET` on a JSON blob is structurally perfect for this

**Why Redis for circuit breaker state?**

Cloudflare Workers spin up new V8 isolates per request with no shared memory. In-memory circuit breaker state would reset on every request — making it useless. Storing state in Upstash Redis means all isolate instances share the same breaker state atomically.

### Groq for LLM Inference

Both Peek and Silk use Groq. The decision is latency and economics:

- Groq's LPU (Language Processing Unit) hardware is specialized for transformer inference, delivering consistent throughput rather than just fast time-to-first-token
- At the free/low-cost tier, Groq's rate limits are higher than comparable hosted models
- IRA uses two rotating API keys with automatic failover to stay within per-key rate limits

### Gemini for Embeddings

`gemini-embedding-2` (768 dimensions) is used for all vector operations. This was chosen over alternatives because:
- Gemini's embedding model is tightly integrated with its own semantic training, meaning the 768 dimensions carry good information density
- The API is available on a generous free tier
- Keeping embeddings and generation on separate providers adds resilience — a Groq outage does not affect Mesh

---

## 10. Database Schema

### Full schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id             TEXT        PRIMARY KEY,
  platform       TEXT        NOT NULL DEFAULT 'telegram',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memories (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content                 TEXT        NOT NULL,
  importance              FLOAT       DEFAULT 0.5,
  access_count            INTEGER     DEFAULT 0,
  last_accessed           TIMESTAMPTZ DEFAULT NOW(),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  decay_rate              FLOAT       DEFAULT 0.1,
  tier                    TEXT        NOT NULL DEFAULT 'general_fact',
  tags                    TEXT[],
  embedding               vector(768),

  -- archival
  is_archived             BOOLEAN     NOT NULL DEFAULT false,
  archived_at             TIMESTAMPTZ,
  archived_reason         VARCHAR(50),
  decay_score_at_archive  FLOAT,

  -- consolidation
  source_memory_ids       UUID[],
  consolidation_id        UUID,
  is_consolidated_source  BOOLEAN     NOT NULL DEFAULT false,
  memory_type             TEXT        NOT NULL DEFAULT 'source',

  CONSTRAINT memories_archived_reason_check
    CHECK (archived_reason IN ('decay','manual','superseded','gdpr_anonymized','consolidated')),
  CONSTRAINT memories_memory_type_check
    CHECK (memory_type IN ('source','consolidated'))
);
```

### Why each design decision was made

**`tier` column:** Controls initial importance and decay rate. Also scopes consolidation — the job runs within tiers, not across them. You would not merge "user loves chess" with "user lives in Delhi" just because their embeddings are superficially close.

**Archival columns instead of hard delete:** Memories are never hard-deleted immediately. They are soft-archived first. This matters because:
1. Consolidation rollback requires access to archived source memories
2. GDPR right-to-forget needs to permanently wipe data — the `gdpr_anonymized` reason code marks rows for audit before hard deletion
3. `decay_score_at_archive` records the importance value at archive time, useful for debugging decay formula changes

**`memory_type` + `source_memory_ids`:** When a consolidation run merges 8 chess-related memories into one summary, `source_memory_ids` records all 8 UUIDs. This creates a full lineage graph: you can always trace a consolidated memory back to its origins.

**`consolidation_id`:** A single UUID shared by the consolidated memory and all its sources within one consolidation run. Makes rollback trivial — one query by `consolidation_id` finds everything to undo.

### Index design and rationale

| Index | Type | Columns | Purpose |
|---|---|---|---|
| `memories_embedding_idx` | HNSW | `embedding` | Vector similarity search in Mesh |
| `memories_user_id_idx` | BTREE | `user_id` | Basic user-scoped lookups |
| `memories_user_id_last_accessed_idx` | BTREE | `user_id, last_accessed` | Decay re-ranking (sort by recency) |
| `idx_memories_active` | BTREE | `user_id, created_at` | Standard active memory queries |
| `idx_memories_consolidation_candidates` | BTREE | `user_id, tier, access_count, last_accessed` | Tier-scoped consolidation candidate selection |
| `idx_memories_promotion_candidates` | BTREE | `user_id, tier, access_count, created_at` | Identifying memories ready for tier promotion |
| `idx_memories_archived_user` | BTREE | `user_id, archived_at` | Archive management and GDPR hard-delete jobs |
| `idx_memories_consolidation_id` | BTREE | `consolidation_id` | Rollback lookup — find all rows in a consolidation run |
| `idx_memories_consolidation_source` | BTREE | `is_consolidated_source` | Find source memories that have been consumed |

Each index exists for a specific query path. Adding indexes has a write cost — every insert and update touches each index. No index here is speculative.

---

## 11. Metrics

### Latency targets

| Layer | Typical | Timeout Budget | Bottleneck |
|---|---|---|---|
| Peek | 50–100ms | 1000ms | Groq inference |
| Mesh | 400–800ms | 800ms | Gemini embed + Neon HTTP |
| Silk | 800–1200ms | 3000ms | Groq generation |
| **Total (parallel)** | **~900–1300ms** | — | `max(Peek, Mesh) + Silk` |
| Memory write (async) | 200–400ms | — | Gemini embed + Neon insert |
| Telegram send | <200ms | 2000ms | Telegram Bot API |

### Why these specific metrics are tracked

IRA tracks p50, p90, and p99 latencies per layer (stored in Upstash Redis as rolling time-series) for a reason beyond basic observability:

- **p50** tells you what the median user experiences
- **p90** tells you if tail latency is growing — a rising p90 usually means an external dependency (Gemini, Neon) is under load
- **p99** tells you how bad the worst 1% of requests are — this is where circuit breaker thresholds are validated

If Mesh p90 approaches the 800ms budget, it means you are close to the point where Silk starts proceeding without memories for a significant fraction of users. That is a real product quality signal, not just a performance number.

### Key constants

| Parameter | Value | Reasoning |
|---|---|---|
| Embedding dimensions | 768 | Gemini model output; 3KB per row |
| Retrieval top-k | 5 | Enough context without overwhelming Silk's prompt |
| Decay floor | 0.005/day | ~18-month memory horizon |
| Archive threshold | 0.05 | Memory below 5% original importance is not useful |
| Consolidation similarity threshold | 0.85 cosine | High enough to prevent cross-topic merging |
| Circuit breaker threshold | 5 failures | Trips after 5 consecutive failures |
| Circuit breaker cooldown | 60 seconds | Short enough to recover quickly |
| Session history window | 10 turns | Enough conversational context without overloading Silk |

---

## 12. Running Locally

```bash
git clone <repo>
cd ira/worker
npm install

# Copy and fill in environment variables
cp .env.example .env
# Required: DATABASE_URL, GEMINI_API_KEY, GROQ_API_KEY_1, GROQ_API_KEY_2
#           BOT_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

npx wrangler dev
```

Set up the Postgres schema:
```bash
psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql $DATABASE_URL -f schema.sql
```

---

## Project Status

IRA is a learning project built to production-grade architecture standards. It demonstrates:

- Real memory systems beyond naive RAG (decay, tiering, consolidation, deep recall)
- Parallel async pipeline design with latency budgets and graceful degradation
- Circuit breaker pattern in a stateless serverless environment
- Thoughtful schema design for time-sensitive, multi-state data
- Vector search with pgvector in a V8 isolate environment
- Principled decay modeling based on cognitive science, not arbitrary TTLs
- Transactional integrity in background jobs with rollback support

> The dashboard at [ira-dashboard.pages.dev](https://ira-dashboard.pages.dev/) is internal tooling for observing live metrics. It is not user-facing — exposing raw memory contents raises obvious privacy concerns.
