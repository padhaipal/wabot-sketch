// OtelLogger wraps NestJS ConsoleLogger so that every console-style log call
// also feeds OpenTelemetry's logs API. We mock the OTel logger surface,
// silence the underlying ConsoleLogger output, and exercise each of the six
// public methods plus the private emitOtelLog branching (logContext / stack
// extraction, body string-vs-object handling).

const mockOtelEmit = jest.fn();
const mockGetLogger = jest.fn(() => ({ emit: mockOtelEmit }));

jest.mock('@opentelemetry/api-logs', () => ({
  logs: { getLogger: (...args: unknown[]) => mockGetLogger(...args) },
  SeverityNumber: {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  },
}));

import { OtelLogger } from './otel-logger';

describe('OtelLogger', () => {
  let logger: OtelLogger;
  // Silence the underlying ConsoleLogger so test output stays clean.
  const NOOP = () => undefined;

  beforeEach(() => {
    mockOtelEmit.mockReset();
    logger = new OtelLogger();
    // Patch every super method we override so the parent's stdout writes are
    // suppressed; we still assert they got called.
    Object.getPrototypeOf(Object.getPrototypeOf(logger));
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'log')
      .mockImplementation(NOOP);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'error')
      .mockImplementation(NOOP);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'warn')
      .mockImplementation(NOOP);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'debug')
      .mockImplementation(NOOP);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'verbose')
      .mockImplementation(NOOP);
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'fatal')
      .mockImplementation(NOOP);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the OTel logger is opened with name "wabot"', () => {
    // Trigger one emit so the module-level getLogger has definitely run.
    logger.log('boot');
    expect(mockGetLogger).toHaveBeenCalledWith('wabot');
  });

  describe('severity-to-OTel mapping', () => {
    it.each<
      [
        method: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
        severityNumber: number,
        severityText: string,
      ]
    >([
      ['log', 9, 'INFO'],
      ['error', 17, 'ERROR'],
      ['warn', 13, 'WARN'],
      ['debug', 5, 'DEBUG'],
      ['verbose', 1, 'TRACE'],
      ['fatal', 21, 'FATAL'],
    ])('%s → severityNumber %i / severityText %s', (method, num, text) => {
      logger[method]('hello');
      expect(mockOtelEmit).toHaveBeenCalledTimes(1);
      const arg = mockOtelEmit.mock.calls[0][0] as {
        severityNumber: number;
        severityText: string;
      };
      expect(arg.severityNumber).toBe(num);
      expect(arg.severityText).toBe(text);
    });
  });

  describe('body handling', () => {
    it('passes a string message through verbatim', () => {
      logger.log('hello world');
      expect((mockOtelEmit.mock.calls[0][0] as { body: string }).body).toBe(
        'hello world',
      );
    });

    it('JSON.stringifies a non-string message (object)', () => {
      logger.log({ foo: 1, bar: [2, 3] });
      expect((mockOtelEmit.mock.calls[0][0] as { body: string }).body).toBe(
        JSON.stringify({ foo: 1, bar: [2, 3] }),
      );
    });

    it('JSON.stringifies a non-string message (number)', () => {
      logger.log(42);
      expect((mockOtelEmit.mock.calls[0][0] as { body: string }).body).toBe(
        '42',
      );
    });
  });

  describe('log.context attribute (Nest convention: last optionalParam is the context string)', () => {
    it('attached when the last optionalParam is a string', () => {
      logger.log('hi', 'MyContext');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs['log.context']).toBe('MyContext');
    });

    it('omitted when there are no optionalParams', () => {
      logger.log('hi');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs).not.toHaveProperty('log.context');
    });

    it('omitted when the last optionalParam is not a string', () => {
      logger.log('hi', { detail: 'x' });
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs).not.toHaveProperty('log.context');
    });
  });

  describe('exception.stacktrace attribute (only for ERROR+ with ≥2 params and a string first param)', () => {
    it('attached when error() gets a stack as the first optionalParam + a context as the last', () => {
      const stack = 'Error: boom\n    at foo.ts:1:1';
      logger.error('the message', stack, 'MyContext');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs['exception.stacktrace']).toBe(stack);
      expect(attrs['log.context']).toBe('MyContext');
    });

    it('attached on fatal() too (severity ≥ ERROR)', () => {
      logger.fatal('msg', 'stack-string', 'Ctx');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs['exception.stacktrace']).toBe('stack-string');
    });

    it('NOT attached for warn() even with a string first param + context', () => {
      logger.warn('msg', 'pretend-stack', 'Ctx');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs).not.toHaveProperty('exception.stacktrace');
    });

    it('NOT attached when error() gets only one optionalParam', () => {
      logger.error('msg', 'maybe-context');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs).not.toHaveProperty('exception.stacktrace');
    });

    it('NOT attached when error() first optionalParam is not a string', () => {
      logger.error('msg', { stack: 'x' }, 'Ctx');
      const attrs = (
        mockOtelEmit.mock.calls[0][0] as { attributes: Record<string, unknown> }
      ).attributes;
      expect(attrs).not.toHaveProperty('exception.stacktrace');
    });
  });

  describe('super.* delegation (NestJS ConsoleLogger still writes)', () => {
    it.each<
      [
        method: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
        superMethod: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
      ]
    >([
      ['log', 'log'],
      ['error', 'error'],
      ['warn', 'warn'],
      ['debug', 'debug'],
      ['verbose', 'verbose'],
      ['fatal', 'fatal'],
    ])('%s() invokes super.%s() with the same args', (method, sup) => {
      const proto = Object.getPrototypeOf(Object.getPrototypeOf(logger));
      const spy = proto[sup] as jest.Mock;
      logger[method]('msg', 'arg2');
      expect(spy).toHaveBeenCalledWith('msg', 'arg2');
    });
  });
});
