// Required env so outbound.service's lazy getRequiredEnv calls inside
// sendMessage / authHeaders / toLogId don't throw when sendMessage is
// exercised below.
process.env.PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_ACCESS_TOKEN ??= 'test-token';
process.env.LOG_PII_HMAC_KEY ??=
  '0000000000000000000000000000000000000000000000000000000000000000';
process.env.ENV = 'test-outbound-spec';

import Redis from 'ioredis';

// Stable mock object so beforeAll can wire in a real Redis after import.
// `mock` prefix permits the closure reference inside the jest.mock factory.
const mockQueues: {
  connection: Redis | null;
  createQueue: () => null;
  QUEUE_NAMES: Record<string, never>;
} = {
  connection: null,
  createQueue: () => null,
  QUEUE_NAMES: {},
};

// Stub the queues module so importing outbound.service does not require
// REDIS_URL or actually open a Redis connection at import time. The
// connection slot is filled with a real ioredis client in beforeAll for
// tests that exercise sendMessage end-to-end.
jest.mock('../../redis/queues', () => mockQueues);

import { CLAIM_LUA, sendMessage } from './outbound.service';

// Integration test: requires a real Redis. Skipped unless TEST_REDIS_URL is set.
// Run locally:
//   docker run -d --rm --name wabot-test-redis -p 6380:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://localhost:6380 npx jest outbound.service
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeIfRedis = TEST_REDIS_URL ? describe : describe.skip;

describeIfRedis('CLAIM_LUA (integration)', () => {
  let redis: Redis;

  // Use a dedicated env/prefix so tests never collide with production/dev keys
  // even if TEST_REDIS_URL happens to point at a shared instance.
  const PREFIX = '{wabot:test-inflight-spec}';
  const USER = '91test0000000';
  const consecKey = (): string => `${PREFIX}:consecutive-check:user-id:${USER}`;
  const inflightKey = (wamid: string): string =>
    `${PREFIX}:inflight:user-id:${USER}:wamid:${wamid}`;

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.del(
      consecKey(),
      inflightKey('msg-1'),
      inflightKey('msg-2'),
      inflightKey('msg-3'),
    );
  });

  // Both keys present: claim succeeds — returns the original PTTL (ms),
  // DELs only the inflight key, leaves consec intact.
  it('both keys present → returns positive PTTL, DELs only inflight, keeps consec', async () => {
    await redis.set(consecKey(), '1', 'EX', 25);
    await redis.set(inflightKey('msg-1'), '1', 'EX', 25);

    const result = (await redis.eval(
      CLAIM_LUA,
      2,
      inflightKey('msg-1'),
      consecKey(),
    )) as number;

    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(25_000);
    expect(await redis.exists(inflightKey('msg-1'))).toBe(0);
    expect(await redis.exists(consecKey())).toBe(1);
  });

  it('both keys absent → returns 0', async () => {
    const result = await redis.eval(
      CLAIM_LUA,
      2,
      inflightKey('msg-1'),
      consecKey(),
    );
    expect(result).toBe(0);
  });

  // Stale timeout for an old wamid must not interfere with a fresh send.
  // msg N+1 has just set both consec + inflight_N+1. msg N's stale
  // processMessageTimeout fires CLAIM_LUA against (gone) inflight_N and
  // the shared consec. CLAIM_LUA must return 0 (its inflight is gone) and
  // must NOT touch consec — otherwise msg N+1's subsequent claim would see
  // consec missing and bail with inflight-expired.
  it('race: stale timeout for msg N does not block fresh send for msg N+1', async () => {
    await redis.set(consecKey(), '1', 'EX', 25);
    await redis.set(inflightKey('msg-3'), '1', 'EX', 25);

    const staleTimeoutResult = await redis.eval(
      CLAIM_LUA,
      2,
      inflightKey('msg-2'),
      consecKey(),
    );
    expect(staleTimeoutResult).toBe(0);
    // consec must survive the stale timeout's CLAIM_LUA call.
    expect(await redis.exists(consecKey())).toBe(1);

    // msg N+1's claim now succeeds.
    const sendResult = (await redis.eval(
      CLAIM_LUA,
      2,
      inflightKey('msg-3'),
      consecKey(),
    )) as number;
    expect(sendResult).toBeGreaterThan(0);
  });
});

describeIfRedis('sendMessage WhatsApp 4XX recovery (integration)', () => {
  let redis: Redis;
  let originalFetch: typeof global.fetch;

  const PREFIX = '{wabot:test-outbound-spec}';
  const USER = '91test0000000';
  const WAMID = 'wamid-recover-1';
  const consecKey = `${PREFIX}:consecutive-check:user-id:${USER}`;
  const inflightKey = `${PREFIX}:inflight:user-id:${USER}:wamid:${WAMID}`;

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    mockQueues.connection = redis;
    originalFetch = global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    mockQueues.connection = null;
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.del(consecKey, inflightKey);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Reproduces the production incident
  // (trace e699e65ef4085e7f2f479a7b91db3895, 25/4/2026 13:47 IST):
  //   1st sendMessage: claim DELs both keys, fetch returns 400, returns 4XX.
  //   pp-sketch BullMQ retries → 2nd sendMessage with the same wamid.
  // Current (broken) behaviour: 2nd call's INFLIGHT_DEL_LUA returns 0
  //   because both keys are gone, so it short-circuits to inflight-expired
  //   without ever touching WhatsApp. pp-sketch sees delivered:false and
  //   markRolledBack wipes the lesson_state, leaving an orphan media row.
  // Fixed behaviour: claim DELs only inflight; on 4XX inflight is SET back
  //   with its remaining TTL; consec was never deleted. The 2nd claim
  //   succeeds and the message actually goes out.
  it('after WhatsApp 4XX, follow-up sendMessage with same wamid can claim and deliver', async () => {
    // Simulate state after CONSECUTIVE_CHECK_LUA in message.processor.
    await redis.set(consecKey, '1', 'EX', 25);
    await redis.set(inflightKey, '1', 'EX', 25);

    // 1st attempt — WhatsApp Cloud API rejects with 400.
    const fetch400 = jest.fn().mockResolvedValue({
      status: 400,
      ok: false,
      text: async () =>
        JSON.stringify({
          error: {
            code: 131056,
            type: 'OAuthException',
            message: 'pair-rate-limit',
            fbtrace_id: 'trace-1',
          },
        }),
    });
    global.fetch = fetch400 as unknown as typeof global.fetch;

    const first = await sendMessage({
      user_id: USER,
      wamid: WAMID,
      consecutive: false,
      media: [{ type: 'audio', url: 'https://example.com/a.mp3' }],
    });

    expect(first.status).toBe(400);
    expect(first.body.delivered).toBe(false);

    // After 4XX both keys must remain so a retry/timeout/fallback can claim:
    //  - consec: never deleted by claim (claim only DELs inflight)
    //  - inflight: DEL'd by claim, then SET back on 4XX
    expect(await redis.exists(consecKey)).toBe(1);
    expect(await redis.exists(inflightKey)).toBe(1);

    // Recreated inflight has positive TTL no greater than the original 25s.
    const recreatedTtlMs = await redis.pttl(inflightKey);
    expect(recreatedTtlMs).toBeGreaterThan(0);
    expect(recreatedTtlMs).toBeLessThanOrEqual(25_000);

    // 2nd attempt (the BullMQ retry) — WhatsApp accepts.
    const fetch200 = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '{}',
    });
    global.fetch = fetch200 as unknown as typeof global.fetch;

    const second = await sendMessage({
      user_id: USER,
      wamid: WAMID,
      consecutive: false,
      media: [{ type: 'audio', url: 'https://example.com/a.mp3' }],
    });

    // Must actually call WhatsApp (claim succeeded, no inflight-expired
    // short-circuit) and return delivered:true.
    expect(fetch200).toHaveBeenCalled();
    expect(second.status).toBe(200);
    expect(second.body.delivered).toBe(true);
  });
});