// Stub the queues module so importing outbound.service does not require
// REDIS_URL or actually open a Redis connection. We use our own ioredis
// client below to exercise the LUA against a real Redis.
jest.mock('../../redis/queues', () => ({
  connection: null,
  createQueue: () => null,
  QUEUE_NAMES: {},
}));

import Redis from 'ioredis';
import { INFLIGHT_DEL_LUA } from './outbound.service';

// Integration test: requires a real Redis. Skipped unless TEST_REDIS_URL is set.
// Run locally:
//   docker run -d --rm --name wabot-test-redis -p 6380:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://localhost:6380 npx jest outbound.service
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeIfRedis = TEST_REDIS_URL ? describe : describe.skip;

describeIfRedis('INFLIGHT_DEL_LUA (integration)', () => {
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

  // Baseline sanity — must pass with both broken and fixed LUA.
  it('happy path: both keys present → returns 1 and DELs both', async () => {
    await redis.set(consecKey(), '1', 'EX', 25);
    await redis.set(inflightKey('msg-1'), '1', 'EX', 25);

    const result = await redis.eval(
      INFLIGHT_DEL_LUA,
      2,
      inflightKey('msg-1'),
      consecKey(),
    );

    expect(result).toBe(1);
    expect(await redis.exists(consecKey())).toBe(0);
    expect(await redis.exists(inflightKey('msg-1'))).toBe(0);
  });

  it('both keys absent → returns 0', async () => {
    const result = await redis.eval(
      INFLIGHT_DEL_LUA,
      2,
      inflightKey('msg-1'),
      consecKey(),
    );
    expect(result).toBe(0);
  });

  // The regression. Reproduces the race found in trace
  // ff393ee4f525480c9200b930d184f96d:
  //   msg #N+1's checkConsecutive just SET consec + inflight_N+1.
  //   msg #N's stale processMessageTimeout fires and calls INFLIGHT_DEL_LUA
  //     with its own (gone) inflight_N and the (shared, per-user) consec.
  //   The current LUA unconditionally DELs consec as a side effect, which
  //     wipes the window marker that msg #N+1 is relying on. When
  //     msg #N+1's send subsequently runs INFLIGHT_DEL_LUA the consec key is
  //     already gone, `del1==1 and del2==1` is false, and the caller
  //     receives a false-positive "Inflight expired" → message never
  //     delivered to WhatsApp even though its inflight key was perfectly
  //     valid.
  //
  // With the current (broken) LUA this assertion FAILS (sendResult === 0).
  // With the fix (conditional DEL of consec) this assertion PASSES.
  it('race: stale timeout for msg N does not block fresh send for msg N+1', async () => {
    // Simulate msg N+1's checkConsecutive: both keys set, 25s TTL.
    await redis.set(consecKey(), '1', 'EX', 25);
    await redis.set(inflightKey('msg-3'), '1', 'EX', 25);

    // Simulate msg N's stale timeout firing first.
    // inflight_msg-2 does not exist (msg N's send already DEL'd it, or it
    // expired). consec is msg N+1's freshly-set one.
    const staleTimeoutResult = await redis.eval(
      INFLIGHT_DEL_LUA,
      2,
      inflightKey('msg-2'),
      consecKey(),
    );
    expect(staleTimeoutResult).toBe(0);

    // Now msg N+1's send runs. Its own inflight is still alive (we set it
    // ~ms ago) — the message is deliverable regardless of whatever happened
    // to the shared consec key. A correct LUA returns 1.
    const sendResult = await redis.eval(
      INFLIGHT_DEL_LUA,
      2,
      inflightKey('msg-3'),
      consecKey(),
    );
    expect(sendResult).toBe(1);
  });
});