// InternalApiKeyGuard compares the `x-api-key` request header to
// process.env.INTERNAL_API_KEY using a timing-safe comparison. We cover every
// rejection branch (missing header / wrong type / empty / length-mismatch /
// content-mismatch) and the happy path.

import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';

function makeCtx(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }) as unknown,
    }),
  } as unknown as ExecutionContext;
}

describe('InternalApiKeyGuard', () => {
  const guard = new InternalApiKeyGuard();

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  it('returns true when x-api-key exactly matches INTERNAL_API_KEY', () => {
    process.env.INTERNAL_API_KEY = 'secret-key-1';
    expect(guard.canActivate(makeCtx({ 'x-api-key': 'secret-key-1' }))).toBe(
      true,
    );
  });

  it('throws Unauthorized when the request header is missing', () => {
    process.env.INTERNAL_API_KEY = 'secret-key-1';
    expect(() => guard.canActivate(makeCtx({}))).toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the request header is an array (express multi-value)', () => {
    process.env.INTERNAL_API_KEY = 'secret-key-1';
    expect(() =>
      guard.canActivate(makeCtx({ 'x-api-key': ['secret-key-1'] })),
    ).toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the env var is missing', () => {
    expect(() =>
      guard.canActivate(makeCtx({ 'x-api-key': 'secret-key-1' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the header is an empty string', () => {
    process.env.INTERNAL_API_KEY = 'secret-key-1';
    expect(() => guard.canActivate(makeCtx({ 'x-api-key': '' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws Unauthorized when the env var is an empty string', () => {
    process.env.INTERNAL_API_KEY = '';
    expect(() =>
      guard.canActivate(makeCtx({ 'x-api-key': 'anything' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws Unauthorized on length mismatch (different lengths short-circuit timing-safe compare)', () => {
    process.env.INTERNAL_API_KEY = 'short';
    expect(() =>
      guard.canActivate(makeCtx({ 'x-api-key': 'much-longer-key' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws Unauthorized on same-length but mismatched content', () => {
    process.env.INTERNAL_API_KEY = 'aaaa-bbbb';
    expect(() =>
      guard.canActivate(makeCtx({ 'x-api-key': 'aaaa-bbbX' })),
    ).toThrow(UnauthorizedException);
  });
});
