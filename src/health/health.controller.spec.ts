// Mock the queues module — module-load side effect opens a real Redis
// socket, which we never want in unit tests.
const mockPing = jest.fn();
jest.mock('../interfaces/redis/queues', () => ({
  connection: { ping: (...args: unknown[]) => mockPing(...args) },
  createQueue: jest.fn(),
  QUEUE_NAMES: {},
}));

import { HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';

type ResLike = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeRes(): ResLike {
  const res: ResLike = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('HealthController.check', () => {
  beforeEach(() => {
    mockPing.mockReset();
  });

  it('returns 200 + status=ok when redis ping returns PONG', async () => {
    mockPing.mockResolvedValue('PONG');
    const controller = new HealthController();
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.checks.redis.status).toBe('up');
    expect(typeof body.checks.redis.latency_ms).toBe('number');
    expect(body.checks.redis.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.uptime_ms).toBe('number');
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 + degraded when redis ping returns a value other than PONG', async () => {
    mockPing.mockResolvedValue('NOPE');
    const controller = new HealthController();
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.checks.redis.status).toBe('down');
  });

  it('returns 503 + degraded when redis ping rejects', async () => {
    mockPing.mockRejectedValue(new Error('connection refused'));
    const controller = new HealthController();
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.checks.redis.status).toBe('down');
  });

  it('marks redis down when ping exceeds the 5s timeout', async () => {
    jest.useFakeTimers();
    let resolvePing: (v: unknown) => void = () => {};
    const pingPromise = new Promise((resolve) => {
      resolvePing = resolve;
    });
    mockPing.mockReturnValue(pingPromise);

    const controller = new HealthController();
    const res = makeRes();
    const done = controller.check(res as never);

    await jest.advanceTimersByTimeAsync(5_001);
    resolvePing('PONG');
    await done;

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = res.json.mock.calls[0][0];
    expect(body.checks.redis.status).toBe('down');
    jest.useRealTimers();
  });
});
