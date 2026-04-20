import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';

interface ValidResult<T> {
  success: true;
  dto: T;
}

interface InvalidResult {
  success: false;
  errors: string[];
}

export function validateJobData<T extends object>(
  cls: new () => T,
  data: unknown,
): ValidResult<T> | InvalidResult {
  const instance = plainToInstance(cls, data as Record<string, unknown>);
  const validationErrors = validateSync(instance);

  if (validationErrors.length > 0) {
    return { success: false, errors: flattenErrors(validationErrors) };
  }

  return { success: true, dto: instance };
}

function flattenErrors(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((err) => {
    const path = prefix ? `${prefix}.${err.property}` : err.property;

    const messages = err.constraints
      ? Object.values(err.constraints).map((msg) => `${path}: ${msg}`)
      : [];

    const nested = err.children?.length
      ? flattenErrors(err.children, path)
      : [];

    return [...messages, ...nested];
  });
}
