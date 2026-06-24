// AcceptController is the public WhatsApp webhook endpoint. We cover:
//   - GET /webhook verify flow: every guard + the happy-path challenge echo
//   - POST /webhook signature gate + span lifecycle (Error / non-Error catch)

// Stub the queues module so importing accept.service does not require
// REDIS_URL or actually open a Redis connection at import time. The
// controller's tests use a fully mocked AcceptService anyway.
jest.mock('../../../redis/queues', () => ({
  createQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
  QUEUE_NAMES: {
    INGEST: 'ingest',
    PROCESS_MESSAGE: 'process-message',
    PROCESS_STATUS: 'process-status',
    PROCESS_ERRORS: 'process-errors',
    PROCESS_MESSAGE_TIMEOUT: 'process-message-timeout',
  },
}));

const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const mockStartSpan = jest.fn().mockReturnValue({
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
});
const mockGetTracer = jest.fn().mockReturnValue({ startSpan: mockStartSpan });
const mockSetSpan = jest.fn().mockReturnValue('ctx-with-span');
const mockContextActive = jest.fn().mockReturnValue('active-ctx');
const mockPropagationInject = jest.fn();
const mockPropagationGetBaggage = jest.fn();
const mockPropagationCreateBaggage = jest.fn();
const mockPropagationSetBaggage = jest.fn();

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: (...args: unknown[]) => mockGetTracer(...args),
    setSpan: (...args: unknown[]) => mockSetSpan(...args),
  },
  propagation: {
    inject: (...args: unknown[]) => mockPropagationInject(...args),
    getBaggage: (...args: unknown[]) => mockPropagationGetBaggage(...args),
    createBaggage: (...args: unknown[]) =>
      mockPropagationCreateBaggage(...args),
    setBaggage: (...args: unknown[]) => mockPropagationSetBaggage(...args),
  },
  context: { active: () => mockContextActive() },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

jest.mock('../../../../otel/baggage-keys', () => ({
  BAGGAGE_TEST_PHASE: 'padhaipal.test_phase',
}));

import { AcceptController } from './accept.controller';
import type { AcceptService } from './accept.service';

function makeRes(): {
  res: {
    status: jest.Mock;
    type: jest.Mock;
    send: jest.Mock;
  };
} {
  const res = {
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return { res };
}

describe('AcceptController.verifyWebhook (GET /webhook)', () => {
  let acceptSvc: jest.Mocked<AcceptService>;
  let ctrl: AcceptController;

  beforeEach(() => {
    acceptSvc = {
      isValidSignature: jest.fn(),
      receiveWebhook: jest.fn(),
    } as unknown as jest.Mocked<AcceptService>;
    ctrl = new AcceptController(acceptSvc);
    process.env.WHATSAPP_VERIFY_TOKEN = 'expected-token';
  });

  afterEach(() => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
  });

  it('happy path: mode=subscribe + matching token → 200 text/plain echoing the challenge', () => {
    const { res } = makeRes();
    ctrl.verifyWebhook(
      'subscribe',
      'expected-token',
      'a-challenge',
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('a-challenge');
  });

  it.each<[string, string | undefined, string | undefined, string | undefined]>(
    [
      ['mode is wrong', 'unsubscribe', 'expected-token', 'a-challenge'],
      ['verifyToken missing', 'subscribe', undefined, 'a-challenge'],
      ['verifyToken wrong', 'subscribe', 'wrong-token', 'a-challenge'],
      ['challenge missing', 'subscribe', 'expected-token', undefined],
    ],
  )('responds 403 when %s', (_label, mode, token, challenge) => {
    const { res } = makeRes();
    ctrl.verifyWebhook(mode, token, challenge, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith();
  });

  it('responds 403 when WHATSAPP_VERIFY_TOKEN env is unset', () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const { res } = makeRes();
    ctrl.verifyWebhook('subscribe', 'whatever', 'challenge', res as never);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('AcceptController.receiveWebhook (POST /webhook)', () => {
  let acceptSvc: jest.Mocked<AcceptService>;
  let ctrl: AcceptController;

  beforeEach(() => {
    mockStartSpan.mockClear();
    mockSpanSetStatus.mockClear();
    mockSpanRecordException.mockClear();
    mockSpanEnd.mockClear();
    mockPropagationInject.mockClear();
    acceptSvc = {
      isValidSignature: jest.fn(),
      receiveWebhook: jest.fn(),
    } as unknown as jest.Mocked<AcceptService>;
    ctrl = new AcceptController(acceptSvc);
  });

  it('responds 401 when request.rawBody is not a Buffer', async () => {
    const { res } = makeRes();
    await ctrl.receiveWebhook(
      { x: 1 },
      { rawBody: undefined } as never,
      'sig',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith();
    expect(acceptSvc.isValidSignature).not.toHaveBeenCalled();
  });

  it('responds 401 when isValidSignature returns false', async () => {
    const { res } = makeRes();
    acceptSvc.isValidSignature.mockReturnValue(false);
    await ctrl.receiveWebhook(
      { x: 1 },
      { rawBody: Buffer.from('payload') } as never,
      'sig',
      undefined,
      res as never,
    );
    expect(acceptSvc.isValidSignature).toHaveBeenCalledWith(
      'sig',
      Buffer.from('payload'),
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  it('on valid signature: opens span, injects carrier, calls service, echoes status', async () => {
    const { res } = makeRes();
    acceptSvc.isValidSignature.mockReturnValue(true);
    acceptSvc.receiveWebhook.mockResolvedValue(200);
    await ctrl.receiveWebhook(
      { entries: [] },
      { rawBody: Buffer.from('p') } as never,
      'sig',
      undefined,
      res as never,
    );
    expect(mockStartSpan).toHaveBeenCalledWith('enqueue-ingest');
    expect(mockSetSpan).toHaveBeenCalledWith('active-ctx', expect.any(Object));
    expect(mockPropagationInject).toHaveBeenCalledWith(
      'ctx-with-span',
      expect.any(Object),
    );
    expect(acceptSvc.receiveWebhook).toHaveBeenCalledWith(
      { entries: [] },
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('service throws an Error → span ERROR + recordException + rethrows', async () => {
    const { res } = makeRes();
    acceptSvc.isValidSignature.mockReturnValue(true);
    acceptSvc.receiveWebhook.mockRejectedValue(new Error('boom'));
    await expect(
      ctrl.receiveWebhook(
        {},
        { rawBody: Buffer.from('p') } as never,
        'sig',
        undefined,
        res as never,
      ),
    ).rejects.toThrow('boom');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'boom',
    });
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
    expect((recArg as Error).message).toBe('boom');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('service throws a non-Error → String()-d for span message + wrapped for recordException', async () => {
    const { res } = makeRes();
    acceptSvc.isValidSignature.mockReturnValue(true);
    acceptSvc.receiveWebhook.mockRejectedValue('plain-string');
    await expect(
      ctrl.receiveWebhook(
        {},
        { rawBody: Buffer.from('p') } as never,
        'sig',
        undefined,
        res as never,
      ),
    ).rejects.toBe('plain-string');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'plain-string',
    });
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
    expect((recArg as Error).message).toBe('plain-string');
  });

  describe('x-test-phase baggage propagation', () => {
    function setupBaggageMocks(): { setEntry: jest.Mock } {
      const setEntry = jest.fn().mockReturnThis();
      mockPropagationGetBaggage.mockReset().mockReturnValue({ setEntry });
      mockPropagationCreateBaggage.mockReset().mockReturnValue({ setEntry });
      mockPropagationSetBaggage.mockReset().mockReturnValue('ctx-with-baggage');
      return { setEntry };
    }

    it('sets padhaipal.test_phase baggage entry when x-test-phase header is present', async () => {
      const { setEntry } = setupBaggageMocks();
      const { res } = makeRes();
      acceptSvc.isValidSignature.mockReturnValue(true);
      acceptSvc.receiveWebhook.mockResolvedValue(200);
      await ctrl.receiveWebhook(
        { entries: [] },
        { rawBody: Buffer.from('p') } as never,
        'sig',
        'phase_1',
        res as never,
      );
      expect(setEntry).toHaveBeenCalledWith('padhaipal.test_phase', {
        value: 'phase_1',
      });
      // setBaggage is called with the baggage-enriched context, then
      // injection runs on that context so downstream services see it.
      expect(mockPropagationSetBaggage).toHaveBeenCalledTimes(1);
      expect(mockPropagationInject).toHaveBeenCalledWith(
        'ctx-with-baggage',
        expect.any(Object),
      );
    });

    it('does NOT touch baggage when x-test-phase header is omitted', async () => {
      const { setEntry } = setupBaggageMocks();
      const { res } = makeRes();
      acceptSvc.isValidSignature.mockReturnValue(true);
      acceptSvc.receiveWebhook.mockResolvedValue(200);
      await ctrl.receiveWebhook(
        { entries: [] },
        { rawBody: Buffer.from('p') } as never,
        'sig',
        undefined,
        res as never,
      );
      expect(setEntry).not.toHaveBeenCalled();
      expect(mockPropagationSetBaggage).not.toHaveBeenCalled();
      // Injection still runs on the original span-only context.
      expect(mockPropagationInject).toHaveBeenCalledWith(
        'ctx-with-span',
        expect.any(Object),
      );
    });

    it('does NOT touch baggage when x-test-phase header is the empty string', async () => {
      const { setEntry } = setupBaggageMocks();
      const { res } = makeRes();
      acceptSvc.isValidSignature.mockReturnValue(true);
      acceptSvc.receiveWebhook.mockResolvedValue(200);
      await ctrl.receiveWebhook(
        { entries: [] },
        { rawBody: Buffer.from('p') } as never,
        'sig',
        '',
        res as never,
      );
      expect(setEntry).not.toHaveBeenCalled();
      expect(mockPropagationSetBaggage).not.toHaveBeenCalled();
    });

    it('uses createBaggage when no parent baggage exists', async () => {
      const setEntry = jest.fn().mockReturnThis();
      mockPropagationGetBaggage.mockReset().mockReturnValue(undefined);
      mockPropagationCreateBaggage.mockReset().mockReturnValue({ setEntry });
      mockPropagationSetBaggage.mockReset().mockReturnValue('ctx-with-baggage');
      const { res } = makeRes();
      acceptSvc.isValidSignature.mockReturnValue(true);
      acceptSvc.receiveWebhook.mockResolvedValue(200);
      await ctrl.receiveWebhook(
        { entries: [] },
        { rawBody: Buffer.from('p') } as never,
        'sig',
        'phase_2',
        res as never,
      );
      expect(mockPropagationCreateBaggage).toHaveBeenCalledTimes(1);
      expect(setEntry).toHaveBeenCalledWith('padhaipal.test_phase', {
        value: 'phase_2',
      });
    });
  });
});
