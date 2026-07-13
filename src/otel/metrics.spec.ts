// metrics.ts is a thin OTel histogram registration. We verify the meter name,
// histogram name, description, unit, and the explicit bucket boundaries are
// exactly what we ship — these are part of the observability contract with
// the dashboard, so drift here would silently break queries.

const mockCreateHistogram = jest.fn().mockReturnValue({ record: jest.fn() });
const mockCreateCounter = jest.fn().mockReturnValue({ add: jest.fn() });
const mockGetMeter = jest.fn().mockReturnValue({
  createHistogram: mockCreateHistogram,
  createCounter: mockCreateCounter,
});
const mockGetBaggage = jest.fn();
const mockContextActive = jest.fn().mockReturnValue('active-ctx');

jest.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: mockGetMeter },
  propagation: {
    getBaggage: (...a: unknown[]) => mockGetBaggage(...a),
  },
  context: {
    active: () => mockContextActive(),
  },
}));

function makeBaggage(entries: Record<string, string>): {
  getEntry: jest.Mock;
} {
  return {
    getEntry: jest.fn((key: string) =>
      key in entries ? { value: entries[key] } : undefined,
    ),
  };
}

describe('otel/metrics', () => {
  let messageE2eDuration: { record: jest.Mock };

  beforeAll(() => {
    // Importing the module triggers getMeter + createHistogram at the top
    // level, so all assertions can read the captured arguments below.

    messageE2eDuration = require('./metrics').messageE2eDuration;
  });

  it('opens a meter named "wabot"', () => {
    expect(mockGetMeter).toHaveBeenCalledWith('wabot');
  });

  it('exports a messageE2eDuration histogram with the contract name "wabot.message.e2e_duration_ms"', () => {
    expect(mockCreateHistogram).toHaveBeenCalledWith(
      'wabot.message.e2e_duration_ms',
      expect.any(Object),
    );
  });

  it('declares unit "ms" and an end-to-end-latency description', () => {
    const [, opts] = mockCreateHistogram.mock.calls[0];
    expect(opts.unit).toBe('ms');
    expect(opts.description).toMatch(
      /End-to-end milliseconds from WhatsApp message timestamp/,
    );
  });

  it('publishes the exact bucket boundaries (5 ms → 60 s)', () => {
    const [, opts] = mockCreateHistogram.mock.calls[0];
    expect(opts.advice.explicitBucketBoundaries).toEqual([
      5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
      15000, 20000, 25000, 30000, 60000,
    ]);
  });

  it('the exported histogram is the object returned by createHistogram (record is callable)', () => {
    expect(typeof messageE2eDuration.record).toBe('function');
    expect(() => messageE2eDuration.record(123)).not.toThrow();
  });

  it('exports an oversizeTextBlocked counter with the contract name "wabot.outbound.oversize_text_blocked"', () => {
    expect(mockCreateCounter).toHaveBeenCalledWith(
      'wabot.outbound.oversize_text_blocked',
      expect.objectContaining({
        description: expect.stringMatching(/4096-char body limit/) as string,
      }),
    );
    const oversizeTextBlocked = require('./metrics').oversizeTextBlocked as {
      add: jest.Mock;
    };
    expect(typeof oversizeTextBlocked.add).toBe('function');
  });
});

describe('buildOversizeTextAttributes', () => {
  let buildOversizeTextAttributes: (path: string) => Record<string, string>;

  beforeAll(() => {
    buildOversizeTextAttributes =
      require('./metrics').buildOversizeTextAttributes;
  });

  beforeEach(() => {
    mockGetBaggage.mockReset();
  });

  it('carries the send path and defaults load_test to "false"', () => {
    mockGetBaggage.mockReturnValue(undefined);
    expect(buildOversizeTextAttributes('sendMessage')).toEqual({
      path: 'sendMessage',
      load_test: 'false',
    });
  });

  it('reads padhaipal.load_test from baggage when present', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({ 'padhaipal.load_test': 'true' }),
    );
    expect(buildOversizeTextAttributes('sendNotification')).toEqual({
      path: 'sendNotification',
      load_test: 'true',
    });
  });
});

describe('buildE2eAttributes', () => {
  let buildE2eAttributes: (outcome: string) => Record<string, string>;

  beforeAll(() => {
    buildE2eAttributes = require('./metrics').buildE2eAttributes;
  });

  beforeEach(() => {
    mockGetBaggage.mockReset();
  });

  it('defaults load_test to "false" when no baggage exists', () => {
    mockGetBaggage.mockReturnValue(undefined);
    expect(buildE2eAttributes('delivered')).toEqual({
      outcome: 'delivered',
      load_test: 'false',
    });
  });

  it('reads padhaipal.load_test=true from baggage when present', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({ 'padhaipal.load_test': 'true' }),
    );
    expect(buildE2eAttributes('delivered')).toEqual({
      outcome: 'delivered',
      load_test: 'true',
    });
  });

  it('includes test_phase when set in baggage', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'true',
        'padhaipal.test_phase': 'phase_1',
      }),
    );
    expect(buildE2eAttributes('success')).toEqual({
      outcome: 'success',
      load_test: 'true',
      test_phase: 'phase_1',
    });
  });

  it('omits test_phase when its baggage value is the empty string', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'false',
        'padhaipal.test_phase': '',
      }),
    );
    const attrs = buildE2eAttributes('delivered');
    expect(attrs.test_phase).toBeUndefined();
    expect(attrs.load_test).toBe('false');
  });

  it('preserves each outcome literal exactly', () => {
    mockGetBaggage.mockReturnValue(undefined);
    for (const o of [
      'success',
      'delivered',
      'inflight-expired',
      'whatsapp-error',
      'fallback',
    ]) {
      expect(buildE2eAttributes(o).outcome).toBe(o);
    }
  });

  it('reads from the active OTel context', () => {
    mockGetBaggage.mockReturnValue(undefined);
    buildE2eAttributes('delivered');
    expect(mockGetBaggage).toHaveBeenLastCalledWith('active-ctx');
  });
});

describe('buildUserE2eAttributes', () => {
  // Unlike buildE2eAttributes this takes labels as arguments (they travel
  // through the Redis correlation payload, not baggage — the delivered
  // status webhook is a fresh Meta request with no baggage attached).

  const { buildUserE2eAttributes } = require('./metrics') as {
    buildUserE2eAttributes: (
      outcome: string,
      loadTest: string,
      testPhase?: string,
    ) => Record<string, string>;
  };

  it('builds outcome + load_test without test_phase when absent', () => {
    expect(buildUserE2eAttributes('delivered', 'false')).toEqual({
      outcome: 'delivered',
      load_test: 'false',
    });
  });

  it('includes test_phase when provided and non-empty', () => {
    expect(buildUserE2eAttributes('late', 'true', 'phase_2')).toEqual({
      outcome: 'late',
      load_test: 'true',
      test_phase: 'phase_2',
    });
  });

  it('omits test_phase when empty string', () => {
    expect(buildUserE2eAttributes('delivered', 'true', '')).toEqual({
      outcome: 'delivered',
      load_test: 'true',
    });
  });

  it('does not read baggage at all', () => {
    mockGetBaggage.mockClear();
    buildUserE2eAttributes('delivered', 'false');
    expect(mockGetBaggage).not.toHaveBeenCalled();
  });
});
