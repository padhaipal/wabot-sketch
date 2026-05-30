// toLogId derives a stable per-deployment HMAC-SHA256 token for a phone
// number, truncated to 10 hex chars. We test:
//   - missing env / short key → throws with a descriptive message
//   - same input on the same deployment → same token (cache + determinism)
//   - different inputs on the same deployment → different tokens
//   - the returned token shape is `u_<10 hex chars>`
//
// The key is cached at module level, so each scenario has to be exercised
// via jest.isolateModules to get a fresh require.

describe('toLogId', () => {
  const HEX_64 =
    '0000000000000000000000000000000000000000000000000000000000000000';
  const HEX_64_ALT =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function freshToLogId(): (phone: string) => string {
    let fn!: (phone: string) => string;
    jest.isolateModules(() => {
      // Synchronous require so the module-level key cache is fresh per test.

      fn = require('./pii').toLogId;
    });
    return fn;
  }

  afterEach(() => {
    delete process.env.LOG_PII_HMAC_KEY;
  });

  it('throws when LOG_PII_HMAC_KEY is not set', () => {
    expect(() => freshToLogId()('911234567890')).toThrow(
      'LOG_PII_HMAC_KEY environment variable is required.',
    );
  });

  it('throws when LOG_PII_HMAC_KEY hex-decodes to fewer than 32 bytes', () => {
    process.env.LOG_PII_HMAC_KEY = 'deadbeef'; // 4 bytes
    expect(() => freshToLogId()('911234567890')).toThrow(
      'LOG_PII_HMAC_KEY must be a hex-encoded key of at least 32 bytes (64 hex chars).',
    );
  });

  it('returns a token shaped like `u_<10 hex chars>`', () => {
    process.env.LOG_PII_HMAC_KEY = HEX_64;
    expect(freshToLogId()('911234567890')).toMatch(/^u_[0-9a-f]{10}$/);
  });

  it('is deterministic for the same input within the same deployment', () => {
    process.env.LOG_PII_HMAC_KEY = HEX_64;
    const toLogId = freshToLogId();
    expect(toLogId('911234567890')).toBe(toLogId('911234567890'));
  });

  it('different inputs produce different tokens', () => {
    process.env.LOG_PII_HMAC_KEY = HEX_64;
    const toLogId = freshToLogId();
    expect(toLogId('911234567890')).not.toBe(toLogId('919876543210'));
  });

  it('different deployment keys produce different tokens for the same input', () => {
    process.env.LOG_PII_HMAC_KEY = HEX_64;
    const tokenA = freshToLogId()('911234567890');
    process.env.LOG_PII_HMAC_KEY = HEX_64_ALT;
    const tokenB = freshToLogId()('911234567890');
    expect(tokenA).not.toBe(tokenB);
  });

  it('caches the key after the first call (second call does not re-read env)', () => {
    process.env.LOG_PII_HMAC_KEY = HEX_64;
    const toLogId = freshToLogId();
    const first = toLogId('911234567890');
    // Wipe the env after the first call; the second call must still work
    // because the key is cached.
    delete process.env.LOG_PII_HMAC_KEY;
    expect(() => toLogId('911234567890')).not.toThrow();
    expect(toLogId('911234567890')).toBe(first);
  });
});
