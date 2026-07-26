import Fastify from 'fastify';
import { strictEqual, ok } from 'node:assert';
import { rateRoutes, __resetCache } from '../routes/rate.js';
import { AppError } from '../utils/errors.js';

const MOCK_RATE = 18.42;
const FUTURE_MS = 120_000; // advance past 60s TTL

/**
 * Mock that makes every source fail (returns a non-ok HTTP status).
 * The route will exhaust all 4 sources and fall back to a hardcoded
 * FALLBACK_RATE with { stale: true }.
 */
function mockFetchFail(): void {
  globalThis.fetch = async () => new Response(null, { status: 429 });
}

/**
 * Mock that returns valid CoinGecko XLM/MXN JSON for every request.
 * The first two sources (Coinbase, Kraken) expect different shapes, so they
 * throw and fall through; CoinGecko (3rd source) succeeds.
 */
function mockFetchOk(): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ stellar: { mxn: MOCK_RATE } }), { status: 200 });
}

function installErrorHandler(app: ReturnType<typeof Fastify>) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({
        code: error.code,
        message: error.userMessage,
      });
      return;
    }
    reply.status(500).send({ code: 'INTERNAL_ERROR', message: error.message });
  });
}

async function createApp() {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  await app.register(rateRoutes);
  await app.ready();
  return app;
}

async function testScenarios() {
  console.log('Running Rate Cache Tests...\n');

  // ── Scenario 1: All sources fail, no cache → hardcoded fallback (200 stale) ──
  console.log('1. All sources unavailable, no cache → hardcoded fallback');
  __resetCache();
  mockFetchFail();
  const app1 = await createApp();
  const res1 = await app1.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  strictEqual(res1.statusCode, 200, 'Route returns 200 with hardcoded fallback when all sources fail');
  const body1f = JSON.parse(res1.body);
  strictEqual(body1f.source, 'fallback', 'Source should be fallback when all sources fail');
  strictEqual(body1f.stale, true, 'Fallback response should be marked stale');
  ok(typeof body1f.rate === 'number' && body1f.rate > 0, 'Fallback rate should be a positive number');
  console.log('   ✓ 200 with source=fallback, stale=true\n');
  await app1.close();

  // ── Scenario 2: Fresh fetch sets cache, then cache hit within TTL ──
  console.log('2. Fresh fetch followed by cache hit (TTL)');
  __resetCache();
  mockFetchOk();
  const app2 = await createApp();

  const req1 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body1 = JSON.parse(req1.body);
  strictEqual(req1.statusCode, 200);
  strictEqual(body1.rate, MOCK_RATE);
  // Source is 'coingecko' because coinbase/kraken parse the CoinGecko-shaped JSON and fail
  strictEqual(body1.source, 'coingecko', 'CoinGecko source should win when mock returns CoinGecko-shaped JSON');
  ok(body1.fetchedAt);
  ok(!body1.stale);
  console.log('   ✓ First request: fresh data (source=coingecko)');

  mockFetchFail();
  const req2 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body2 = JSON.parse(req2.body);
  strictEqual(req2.statusCode, 200);
  strictEqual(body2.rate, MOCK_RATE);
  strictEqual(body2.fetchedAt, body1.fetchedAt, 'fetchedAt identical (served from cache)');
  strictEqual(body2.source, 'coingecko');
  ok(!body2.stale, 'Cache hit within TTL should not be marked stale');
  console.log('   ✓ Second request: served from cache (no fetch)\n');

  // ── Scenario 3: Cache expired, all sources fail → stale fallback from cache ──
  console.log('3. All sources fail, expired cache → stale fallback');
  const origDateNow = Date.now;
  Date.now = () => origDateNow() + FUTURE_MS;

  const req3 = await app2.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  Date.now = origDateNow;
  strictEqual(req3.statusCode, 200);
  const body3 = JSON.parse(req3.body);
  strictEqual(body3.rate, MOCK_RATE, 'Stale response should return last-known rate');
  strictEqual(body3.source, 'coingecko');
  strictEqual(body3.stale, true, 'Expired cache with failing sources should be marked stale');
  ok(body3.fetchedAt);
  console.log('   ✓ 200 with stale=true (last-known cache served)\n');
  await app2.close();

  // ── Scenario 4: Response shape — fresh ──
  console.log('4. Response shape — fresh data');
  __resetCache();
  mockFetchOk();
  const app4 = await createApp();
  const res4 = await app4.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  const body4 = JSON.parse(res4.body);
  ok('rate' in body4, 'Fresh response must have rate');
  ok('source' in body4, 'Fresh response must have source');
  ok('fetchedAt' in body4, 'Fresh response must have fetchedAt');
  ok(!body4.stale, 'Fresh response must not have stale=true');
  strictEqual(body4.source, 'coingecko');
  console.log('   ✓ Fresh: { rate, source, fetchedAt } (no stale)\n');
  await app4.close();

  // ── Scenario 5: Response shape — stale ──
  console.log('5. Response shape — stale data');
  __resetCache();
  mockFetchOk();
  const app5 = await createApp();
  await app5.inject({ method: 'GET', url: '/rate/xlm-mxn' }); // prime cache
  mockFetchFail();
  const origDateNow5 = Date.now;
  Date.now = () => origDateNow5() + FUTURE_MS; // expire cache
  const res5 = await app5.inject({ method: 'GET', url: '/rate/xlm-mxn' });
  Date.now = origDateNow5;
  const body5 = JSON.parse(res5.body);
  strictEqual(body5.stale, true, 'Stale response must have stale=true');
  strictEqual(body5.rate, MOCK_RATE, 'Stale response must return cached rate');
  strictEqual(body5.source, 'coingecko');
  ok(body5.fetchedAt);
  console.log('   ✓ Stale: { rate, source, fetchedAt, stale }\n');
  await app5.close();

  console.log('✅ All Rate Cache Tests Passed!');
}

testScenarios().catch(err => {
  console.error('Tests failed:', err);
  process.exit(1);
});
