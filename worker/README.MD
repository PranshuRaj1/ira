![alt text](image.png)

The IVFFlat index needs at least 1000 rows to be effective. For early stage, use HNSW instead -- it works well at any size.

Cloudflare Workers can't use pg (it needs TCP). Use Neon's HTTP driver instead  it works over fetch:Cloudflare Workers run in a V8 isolate, not a real Node.js environment. This is the core reason.

Neon built an HTTP wrapper around Postgres queries. Instead of a TCP socket, it sends your SQL as an HTTP POST:

your code → fetch() → Neon HTTP endpoint → Neon proxies it → Postgres

That sql call is literally just a fetch() under the hood. Which Workers can do fine.


my DB design now 

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id             TEXT        PRIMARY KEY,
  platform       TEXT        NOT NULL DEFAULT 'telegram',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memories (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT        NOT NULL,
  importance    FLOAT       DEFAULT 0.5,
  access_count  INTEGER     DEFAULT 0,
  last_accessed TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  decay_rate    FLOAT       DEFAULT 0.1,
  tier          TEXT        NOT NULL DEFAULT 'general_fact',
  tags          TEXT[],
  embedding     vector(768)
);

CREATE TABLE messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON memories (user_id);
CREATE INDEX ON memories (user_id, last_accessed DESC);
CREATE INDEX ON messages (user_id, created_at DESC);


SOME THEORY :
Peek:
What is this message about? 
A  fast, cheap classification call. It reads the incoming message and answers two questions:

What is the user trying to do? (question / statement / greeting / command)
Does this message reveal something worth remembering? If yes, what exactly?

Example : Example: User sends "My name is Pranshu and I love chess"
Peek returns:

{
  "intent": "statement",
  "shouldSaveMemory": true,
  "memoryHint": "user's name is Prem and loves chess"
}

It runs in ~50-100ms because it's just a small Groq call with no DB involved.


Mesh
"What do I already know about this user?"
Searches the memory database for context relevant to the current message. It:

Converts the message into a 768-dim embedding (Gemini)
Does a cosine similarity search in Neon (pgvector)
Re-ranks results by decayed importance
Returns the top 5 most relevant memories

Example: User sends "What should I play today?"
Mesh finds memories like:

"user loves chess" (importance: 0.9)
"user plays on weekends" (importance: 0.6)

Runs in ~400-800ms because it hits Gemini for embedding + Neon for search.

Silk
"What should I say back?"
The response generator. It waits for both Peek and Mesh to finish, then combines everything into a reply:

Takes the user's message
Takes the memories Mesh found
Takes the conversation history from Redis
Sends it all to Groq and generates the actual response

Example output: "Since you love chess, maybe spend some time on tactics puzzles today!"
Runs in ~800-1200ms because it's the full LLM generation call.

Why three separate layers instead of one
You could send everything to one LLM call and get the same result. The reason for separating them:
Peek and Mesh run in parallel while Mesh is searching the DB (slow), Peek is classifying intent (fast). They don't need each other. So total time is max(Peek, Mesh) + Silk instead of Peek + Mesh + Silk.
Each layer has one job easier to debug, swap, or improve independently. If memory retrieval is slow, you fix Mesh without touching Silk.
It mirrors how a human assistant thinks first understand the request, then recall relevant context, then respond.


Dashboard link : https://ira-dashboard.pages.dev/ (I am pretty much sure dashboard like these needs to not shown to users(privacy issues) but It is learn so that later I can earn project)
Talk to IRA on Telegram: @ira_memory_bot
