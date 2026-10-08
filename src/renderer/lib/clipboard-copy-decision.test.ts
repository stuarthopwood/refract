// Quality-gate remediation (cycle 4, PR #597): regression coverage for CopyButton's pure
// click-handler decisions (previously only reachable through the React component, which vitest's
// `node` environment cannot render).
import { describe, it, expect } from 'vitest';
import { copyDecision, clipboardRejectionToResult } from './clipboard-copy-decision';

describe('copyDecision', () => {
  it('decides to copy non-empty sanitised text', () => {
    expect(copyDecision('export const x = 1')).toEqual({ kind: 'copy', text: 'export const x = 1' });
  });

  it('decides there is nothing to copy when the sanitised text is empty', () => {
    expect(copyDecision('')).toEqual({ kind: 'nothing' });
  });
});

describe('clipboardRejectionToResult', () => {
  it('builds a clipboard-failed Result from an Error', () => {
    expect(clipboardRejectionToResult(new Error('channel gone'))).toEqual({
      ok: false,
      error: { code: 'clipboard-failed', message: 'channel gone' },
    });
  });

  it('builds a clipboard-failed Result from a non-Error throw', () => {
    expect(clipboardRejectionToResult('boom')).toEqual({
      ok: false,
      error: { code: 'clipboard-failed', message: 'boom' },
    });
  });
});
