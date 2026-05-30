// metrics.ts is a thin OTel histogram registration. We verify the meter name,
// histogram name, description, unit, and the explicit bucket boundaries are
// exactly what we ship — these are part of the observability contract with
// the dashboard, so drift here would silently break queries.

const mockCreateHistogram = jest.fn().mockReturnValue({ record: jest.fn() });
const mockGetMeter = jest.fn().mockReturnValue({
  createHistogram: mockCreateHistogram,
});

jest.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: mockGetMeter },
}));

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
});
