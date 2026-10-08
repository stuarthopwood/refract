// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "no tests for the IPC validation
// (isModelRoleId/isCatalogKind rejections...) or the toIpcError mapping").
import { describe, expect, it } from 'vitest';
import { toIpcError } from './modelRoles';
import { OmpConfigError } from '../omp/config';

describe('toIpcError', () => {
  it('maps an OmpConfigError with code timeout to IpcErrorCode timeout', () => {
    expect(toIpcError(new OmpConfigError('timeout', 'omp config timed out.'))).toEqual({ code: 'timeout', message: 'omp config timed out.' });
  });

  it('maps an OmpConfigError with code invalid-value to IpcErrorCode invalid-argument', () => {
    expect(toIpcError(new OmpConfigError('invalid-value', 'Model selector cannot be blank.'))).toEqual({
      code: 'invalid-argument',
      message: 'Model selector cannot be blank.',
    });
  });

  it('maps every other OmpConfigError code to omp-probe-failed', () => {
    for (const code of ['omp-not-found', 'omp-failed', 'parse-failed'] as const) {
      expect(toIpcError(new OmpConfigError(code, 'some message'))).toEqual({ code: 'omp-probe-failed', message: 'some message' });
    }
  });

  it('maps a plain Error to omp-probe-failed, using its own message', () => {
    expect(toIpcError(new Error('boom'))).toEqual({ code: 'omp-probe-failed', message: 'boom' });
  });

  it('maps a non-Error thrown value to omp-probe-failed via String()', () => {
    expect(toIpcError('a string throw')).toEqual({ code: 'omp-probe-failed', message: 'a string throw' });
    expect(toIpcError(42)).toEqual({ code: 'omp-probe-failed', message: '42' });
  });
});
