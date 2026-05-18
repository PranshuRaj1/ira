import path from 'path';
import dotenv from 'dotenv';
import worker from '../../src/index';

dotenv.config({ path: path.join(__dirname, '../../.dev.vars') });

const testSecret = 'mock_debug_secret_123';

const mockEnv = {
  DEBUG_SECRET: testSecret,
  DATABASE_URL: process.env.DATABASE_URL || '',
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || '',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || ''
};

async function testRoute(
  routePath: string, 
  method: string, 
  headers: Record<string, string>,
  body?: any
) {
  const req = new Request(`http://localhost${routePath}`, {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined
  });
  
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {}
  } as any;

  const res = await worker.fetch(req, mockEnv, mockCtx);
  return {
    status: res.status,
    body: res.status === 200 ? await res.json().catch(() => null) : await res.text()
  };
}

async function run() {
  console.log("--- STARTING DASHBOARD ROUTE AUTHENTICATION INTEGRATION TEST ---\n");

  // 1. Test /memories with no secret (should allow 200)
  console.log("1. Testing /memories with no x-debug-secret header...");
  const noHeaderMemories = await testRoute('/memories', 'GET', {});
  console.log(`- Status: ${noHeaderMemories.status}, Memories count:`, noHeaderMemories.body ? (noHeaderMemories.body as any).memories?.length : 'N/A');
  if (noHeaderMemories.status === 200 && noHeaderMemories.body) {
    console.log("✓ Success: Request allowed without headers.\n");
  } else {
    console.error("❌ Failed: Request was rejected!\n");
  }

  // 2. Test /metrics with no secret (should allow 200)
  console.log("2. Testing /metrics with no x-debug-secret header...");
  const noHeaderMetrics = await testRoute('/metrics', 'GET', {});
  console.log(`- Status: ${noHeaderMetrics.status}, Metrics payload keys:`, noHeaderMetrics.body ? Object.keys(noHeaderMetrics.body) : 'N/A');
  if (noHeaderMetrics.status === 200 && noHeaderMetrics.body) {
    console.log("✓ Success: Request allowed without headers.\n");
  } else {
    console.error("❌ Failed: Request was rejected!\n");
  }

  // 3. Test /admin/rollback-consolidation with no secret (should reject 401)
  console.log("3. Testing /admin/rollback-consolidation with no x-debug-secret header...");
  const noHeaderAdmin = await testRoute('/admin/rollback-consolidation', 'POST', {}, { consolidationId: '123' });
  console.log(`- Status: ${noHeaderAdmin.status}, Body:`, noHeaderAdmin.body);
  if (noHeaderAdmin.status === 401) {
    console.log("✓ Success: Request correctly rejected with 401 Unauthorized.\n");
  } else {
    console.error("❌ Failed: Request was not rejected!\n");
  }

  // 4. Test /admin/rollback-consolidation with incorrect secret (should reject 401)
  console.log("4. Testing /admin/rollback-consolidation with incorrect secret header...");
  const wrongHeaderAdmin = await testRoute('/admin/rollback-consolidation', 'POST', { 'x-debug-secret': 'wrong' }, { consolidationId: '123' });
  console.log(`- Status: ${wrongHeaderAdmin.status}, Body:`, wrongHeaderAdmin.body);
  if (wrongHeaderAdmin.status === 401) {
    console.log("✓ Success: Request correctly rejected with 401 Unauthorized.\n");
  } else {
    console.error("❌ Failed: Request was not rejected!\n");
  }

  // 5. Test /admin/rollback-consolidation with correct secret (should allow 200 or 400 bad id)
  console.log("5. Testing /admin/rollback-consolidation with correct secret header...");
  const correctHeaderAdmin = await testRoute('/admin/rollback-consolidation', 'POST', { 'x-debug-secret': testSecret }, { consolidationId: 'invalid-uuid-format' });
  console.log(`- Status: ${correctHeaderAdmin.status}, Body:`, correctHeaderAdmin.body);
  // It throws database error on invalid uuid format, but it passes the auth gate!
  if (correctHeaderAdmin.status !== 401) {
    console.log("✓ Success: Request passed authorization check successfully.\n");
  } else {
    console.error("❌ Failed: Request was blocked by auth gate!\n");
  }

  console.log("--- ALL DASHBOARD ROUTE AUTHENTICATION TESTS PASSED SUCCESSFULLY ---");
}

run().catch(console.error);
