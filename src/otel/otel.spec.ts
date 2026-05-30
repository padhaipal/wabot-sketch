// otel.ts is module-level SDK bootstrap. Each scenario re-imports the module
// in an isolated registry with different env so the top-level statements
// re-run. All OTel deps are mocked to keep the test in-process and
// side-effect free.

const mockDiagSetLogger = jest.fn();
const mockSdkStart = jest.fn();
const mockSdkShutdown = jest.fn();
const mockNodeSDKCtor = jest.fn();
const mockGetNodeAutoInstrumentations = jest
  .fn()
  .mockReturnValue('auto-instrumentations');
const mockBatchLogRecordProcessor = jest.fn();
const mockPeriodicExportingMetricReader = jest.fn();
const mockOTLPTraceExporter = jest.fn();
const mockOTLPMetricExporter = jest.fn();
const mockOTLPLogExporter = jest.fn();

jest.mock('@opentelemetry/api', () => ({
  diag: { setLogger: mockDiagSetLogger },
  DiagConsoleLogger: jest.fn().mockImplementation(() => ({ tag: 'console' })),
  DiagLogLevel: { WARN: 'WARN', ERROR: 'ERROR', NONE: 'NONE' },
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
}));
jest.mock('@opentelemetry/exporter-logs-otlp-proto', () => ({
  OTLPLogExporter: mockOTLPLogExporter,
}));
jest.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({
  OTLPMetricExporter: mockOTLPMetricExporter,
}));
jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: mockOTLPTraceExporter,
}));
jest.mock('@opentelemetry/sdk-logs', () => ({
  BatchLogRecordProcessor: mockBatchLogRecordProcessor,
}));
jest.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: mockPeriodicExportingMetricReader,
}));
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mockNodeSDKCtor.mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      start: mockSdkStart,
      shutdown: mockSdkShutdown,
    });
  }),
}));

function importOtel(): void {
  jest.isolateModules(() => {
    require('./otel');
  });
}

describe('otel bootstrap — diag level branches', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    mockDiagSetLogger.mockReset();
    mockSdkStart.mockReset();
    mockSdkShutdown.mockReset().mockResolvedValue(undefined);
    delete process.env.OTEL_DIAG_LOG_LEVEL;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = ORIG_ENV;
  });

  it.each<[string, string]>([
    ['WARN', 'WARN'],
    ['ERROR', 'ERROR'],
    ['NONE', 'NONE'],
    ['warn', 'WARN'], // case-insensitive
  ])(
    'OTEL_DIAG_LOG_LEVEL=%s → diag.setLogger called with %s',
    (envVal, expected) => {
      process.env.OTEL_DIAG_LOG_LEVEL = envVal;
      importOtel();
      expect(mockDiagSetLogger).toHaveBeenCalledWith(
        expect.anything(),
        expected,
      );
    },
  );

  it('invalid OTEL_DIAG_LOG_LEVEL + NODE_ENV !== production → defaults to WARN', () => {
    process.env.OTEL_DIAG_LOG_LEVEL = 'NOPE';
    process.env.NODE_ENV = 'development';
    importOtel();
    expect(mockDiagSetLogger).toHaveBeenCalledWith(expect.anything(), 'WARN');
  });

  it('invalid OTEL_DIAG_LOG_LEVEL + NODE_ENV === production → no diag.setLogger', () => {
    process.env.OTEL_DIAG_LOG_LEVEL = 'NOPE';
    process.env.NODE_ENV = 'production';
    importOtel();
    expect(mockDiagSetLogger).not.toHaveBeenCalled();
  });

  it('no OTEL_DIAG_LOG_LEVEL + NODE_ENV === production → no diag.setLogger', () => {
    process.env.NODE_ENV = 'production';
    importOtel();
    expect(mockDiagSetLogger).not.toHaveBeenCalled();
  });

  it('no OTEL_DIAG_LOG_LEVEL + non-production → defaults to WARN', () => {
    process.env.NODE_ENV = 'test';
    importOtel();
    expect(mockDiagSetLogger).toHaveBeenCalledWith(expect.anything(), 'WARN');
  });
});

describe('otel bootstrap — SDK lifecycle', () => {
  beforeEach(() => {
    mockSdkStart.mockReset();
    mockSdkShutdown.mockReset().mockResolvedValue(undefined);
    mockNodeSDKCtor.mockClear();
  });

  it('constructs NodeSDK with the trace/metric/log exporters + auto instrumentations and starts it', () => {
    importOtel();
    expect(mockNodeSDKCtor).toHaveBeenCalledTimes(1);
    const sdkOpts = mockNodeSDKCtor.mock.calls[0][0] as {
      traceExporter: unknown;
      metricReader: unknown;
      logRecordProcessor: unknown;
      instrumentations: unknown;
    };
    expect(sdkOpts.traceExporter).toBeDefined();
    expect(sdkOpts.metricReader).toBeDefined();
    expect(sdkOpts.logRecordProcessor).toBeDefined();
    expect(sdkOpts.instrumentations).toEqual(['auto-instrumentations']);
    expect(mockSdkStart).toHaveBeenCalledTimes(1);
  });

  it('logs and continues when sdk.start() throws an Error', () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockSdkStart.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => importOtel()).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      'OTel SDK failed to start: Error: boom',
    );
    consoleSpy.mockRestore();
  });

  it('logs and continues when sdk.start() throws a non-Error', () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockSdkStart.mockImplementationOnce(() => {
      throw 'just a string';
    });
    expect(() => importOtel()).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      'OTel SDK failed to start: just a string',
    );
    consoleSpy.mockRestore();
  });
});

describe('otel bootstrap — shutdown handlers', () => {
  beforeEach(() => {
    mockSdkStart.mockReset();
    mockSdkShutdown.mockReset().mockResolvedValue(undefined);
  });

  function registerAndCaptureShutdown(): () => void {
    const onceSpy = jest.spyOn(process, 'once');
    importOtel();
    const sigtermCall = onceSpy.mock.calls.find((c) => c[0] === 'SIGTERM');
    expect(sigtermCall).toBeDefined();
    const sigintCall = onceSpy.mock.calls.find((c) => c[0] === 'SIGINT');
    expect(sigintCall).toBeDefined();
    // Both signals share the same shutdown closure.
    expect(sigtermCall![1]).toBe(sigintCall![1]);
    const shutdown = sigtermCall![1] as () => void;
    onceSpy.mockRestore();
    return shutdown;
  }

  it('registers SIGTERM and SIGINT with the same shutdown closure', () => {
    registerAndCaptureShutdown();
  });

  it('first shutdown invocation calls sdk.shutdown(); second is a no-op (idempotent)', async () => {
    const shutdown = registerAndCaptureShutdown();
    shutdown();
    shutdown();
    // Drain microtasks so the promise chain inside void sdk.shutdown() runs.
    await Promise.resolve();
    expect(mockSdkShutdown).toHaveBeenCalledTimes(1);
  });

  it('logs and sets process.exitCode=1 when sdk.shutdown() rejects with an Error', async () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockSdkShutdown.mockRejectedValueOnce(new Error('shutdown-fail'));
    const origExitCode = process.exitCode;
    const shutdown = registerAndCaptureShutdown();
    shutdown();
    await new Promise((r) => setImmediate(r));
    expect(consoleSpy).toHaveBeenCalledWith(
      'OTel SDK failed to shutdown: Error: shutdown-fail',
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
    consoleSpy.mockRestore();
  });

  it('handles non-Error rejection values from sdk.shutdown()', async () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockSdkShutdown.mockRejectedValueOnce('plain-string-error');
    const origExitCode = process.exitCode;
    const shutdown = registerAndCaptureShutdown();
    shutdown();
    await new Promise((r) => setImmediate(r));
    expect(consoleSpy).toHaveBeenCalledWith(
      'OTel SDK failed to shutdown: plain-string-error',
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
    consoleSpy.mockRestore();
  });
});
