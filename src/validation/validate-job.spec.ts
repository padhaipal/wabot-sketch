// validateJobData wraps plainToInstance + validateSync into a discriminated
// {success, dto} | {success, errors} result. flattenErrors recursively walks
// ValidationError.children so deeply-nested DTOs report a flat list of
// `path.to.field: <constraint message>` strings.

import 'reflect-metadata';
import {
  IsString,
  IsInt,
  IsOptional,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { validateJobData } from './validate-job';

class InnerDto {
  @IsString()
  name!: string;
}

class JobDto {
  @IsString()
  id!: string;

  @IsInt()
  @Min(1)
  retries!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => InnerDto)
  inner?: InnerDto;
}

describe('validateJobData — happy path', () => {
  it('returns {success:true, dto:instance} when the data is valid', () => {
    const result = validateJobData(JobDto, { id: 'job-1', retries: 3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.dto).toBeInstanceOf(JobDto);
      expect(result.dto.id).toBe('job-1');
      expect(result.dto.retries).toBe(3);
    }
  });

  it('coerces plain objects through class-transformer (nested DTO is an instance of its class)', () => {
    const result = validateJobData(JobDto, {
      id: 'job-1',
      retries: 3,
      inner: { name: 'x' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.dto.inner).toBeInstanceOf(InnerDto);
      expect(result.dto.inner!.name).toBe('x');
    }
  });
});

describe('validateJobData — error path', () => {
  it('returns {success:false, errors:[...]} listing each failing constraint', () => {
    const result = validateJobData(JobDto, { id: 123, retries: -5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      // id violates @IsString, retries violates both @IsInt-shape (here it
      // passes because -5 is int) and @Min(1)
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^id: /),
          expect.stringMatching(/^retries: /),
        ]),
      );
    }
  });

  it('flattens nested-DTO errors with dot paths (inner.name: ...)', () => {
    const result = validateJobData(JobDto, {
      id: 'job-1',
      retries: 3,
      inner: { name: 42 }, // wrong type
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.startsWith('inner.name:'))).toBe(true);
    }
  });

  it('emits one error per constraint when a field violates several', () => {
    // retries undefined → fails @IsInt AND (depending on order) @Min.
    const result = validateJobData(JobDto, { id: 'job-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const retryErrors = result.errors.filter((e) => e.startsWith('retries:'));
      expect(retryErrors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('handles ValidationError without constraints (children-only nodes contribute no own messages)', () => {
    // When inner is wrong only in its children, the parent ValidationError for
    // `inner` itself has no constraints — flattenErrors must not emit a row
    // for the parent, only for the children.
    const result = validateJobData(JobDto, {
      id: 'job-1',
      retries: 3,
      inner: { name: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // We should see "inner.name: ..." but NOT a bare "inner: ..." line.
      expect(result.errors.some((e) => e.startsWith('inner.name:'))).toBe(true);
      expect(result.errors.some((e) => /^inner: /.test(e))).toBe(false);
    }
  });
});
