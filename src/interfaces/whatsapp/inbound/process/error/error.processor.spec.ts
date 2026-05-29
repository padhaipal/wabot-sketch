// processError extracts an OTel parent context from job.data.otel.carrier,
// validates ErrorJobDto, logs the WhatsApp error fields, and re-throws when
// validation fails. Spans always end and errors propagate to BullMQ.

import 'reflect-metadata';

const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const mockStartSpan = jest.fn().mockReturnValue({
  setAttribute: mockSpanSetAttribute,
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
});
const mockGetTracer = jest.fn().mockReturnValue({ startSpan: mockStartSpan });
const mockPropagationExtract = jest.fn().mockReturnValue('extracted-ctx');
const mockContextActive = jest.fn().mockReturnValue('active-ctx');

jest.mock('@opentelemetry/api', () => ({
  trace: { getTracer: (...args: unknown[]) => mockGetTracer(...args) },
  propagation: {
    extract: (...args: unknown[]) => mockPropagationExtract(...args),
  },
  context: { active: () => mockContextActive() },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { processError } from './error.processor';

function makeJob(data: unknown, id = 'err-job-1'): Job {
  return { id, data } as unknown as Job;
}

const validData = {
  otel: { carrier: { traceparent: 'tp' } },
  error: {
    code: 131_026,
    title: 'Message Undeliverable',
    message: 'oops',
    error_data: { details: 'recipient unreachable' },
    href: 'https://developers.facebook.com/docs/...',
  },
};

describe('processError', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSpanSetAttribute.mockClear();
    mockSpanSetStatus.mockClear();
    mockSpanRecordException.mockClear();
    mockSpanEnd.mockClear();
    mockStartSpan.mockClear();
    mockPropagationExtract.mockClear();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('extracts the parent context from job.data.otel.carrier and starts "process-error" with it', async () => {
    await processError(makeJob(validData));
    expect(mockPropagationExtract).toHaveBeenCalledWith('active-ctx', {
      traceparent: 'tp',
    });
    expect(mockStartSpan).toHaveBeenCalledWith(
      'process-error',
      {},
      'extracted-ctx',
    );
  });

  it('falls back to {} when carrier is missing (validation then fails, but propagation.extract has already run)', async () => {
    await expect(
      processError(makeJob({ ...validData, otel: {} })),
    ).rejects.toThrow('Invalid error job data');
    expect(mockPropagationExtract).toHaveBeenCalledWith('active-ctx', {});
  });

  it('falls back to {} when otel is missing entirely (no @IsDefined on otel → validation still passes)', async () => {
    await processError(makeJob({ error: validData.error }));
    expect(mockPropagationExtract).toHaveBeenCalledWith('active-ctx', {});
  });

  it('on valid data: sets wa_error.code + .title span attrs and warns with full payload', async () => {
    await processError(makeJob(validData));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('wa_error.code', 131_026);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'wa_error.title',
      'Message Undeliverable',
    );
    expect(warnSpy).toHaveBeenCalledWith('WhatsApp error received', {
      errorCode: 131_026,
      errorTitle: 'Message Undeliverable',
      errorMessage: 'oops',
      errorDetails: 'recipient unreachable',
      errorHref: 'https://developers.facebook.com/docs/...',
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('on invalid data: logs each constraint, sets span ERROR status + recordException, rethrows', async () => {
    await expect(
      processError(makeJob({ otel: validData.otel, error: { code: 'NaN' } })),
    ).rejects.toThrow('Invalid error job data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Invalid error job data \[job=err-job-1\]: error\./,
      ),
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'Invalid error job data',
    });
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('recordException receives an Error wrapping a non-Error throw', async () => {
    // Force the catch by throwing inside setAttribute (any synchronous throw
    // post-validation falls into the unified catch handler).
    mockSpanSetAttribute.mockImplementationOnce(() => {
      throw 'plain-string-error';
    });
    await expect(processError(makeJob(validData))).rejects.toBe(
      'plain-string-error',
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'plain-string-error',
    });
    // recordException must receive an Error instance even though we threw a string.
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
    expect((recArg as Error).message).toBe('plain-string-error');
  });
});
