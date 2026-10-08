// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "carry over the existing :suffix
// when the user picks a catalog selector, with a unit test for that split").
import { describe, expect, it } from 'vitest';
import { applyThinkingSuffixCarryOver, splitThinkingSuffix } from './modelRoleSuffix';

describe('splitThinkingSuffix', () => {
  it('splits a known thinking suffix off the base selector', () => {
    expect(splitThinkingSuffix('anthropic/claude-sonnet-4-5:high')).toEqual({ base: 'anthropic/claude-sonnet-4-5', suffix: ':high' });
  });

  it('recognises every documented thinking level', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'inherit']) {
      expect(splitThinkingSuffix(`provider/model:${level}`)).toEqual({ base: 'provider/model', suffix: `:${level}` });
    }
  });

  it('returns no suffix for a bare selector', () => {
    expect(splitThinkingSuffix('anthropic/claude-sonnet-4-5')).toEqual({ base: 'anthropic/claude-sonnet-4-5', suffix: null });
  });

  it('does not treat an unrecognised trailing colon segment as a thinking suffix', () => {
    expect(splitThinkingSuffix('provider/model:notalevel')).toEqual({ base: 'provider/model:notalevel', suffix: null });
  });

  it('does not match a colon inside the middle of the selector', () => {
    expect(splitThinkingSuffix('openrouter/anthropic/claude-sonnet-5@anthropic')).toEqual({
      base: 'openrouter/anthropic/claude-sonnet-5@anthropic',
      suffix: null,
    });
  });
});

describe('applyThinkingSuffixCarryOver', () => {
  it('carries the current suffix over onto a freshly picked suffix-free selector', () => {
    expect(applyThinkingSuffixCarryOver('openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4-5:high')).toBe('openai/gpt-4.1-mini:high');
  });

  it('leaves the picked value alone when the current value has no suffix', () => {
    expect(applyThinkingSuffixCarryOver('openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4-5')).toBe('openai/gpt-4.1-mini');
  });

  it('leaves the picked value alone when there is no current value at all (role was unset)', () => {
    expect(applyThinkingSuffixCarryOver('openai/gpt-4.1-mini', undefined)).toBe('openai/gpt-4.1-mini');
  });

  it('does not double up a suffix when the freshly picked value already carries its own', () => {
    expect(applyThinkingSuffixCarryOver('openai/gpt-4.1-mini:low', 'anthropic/claude-sonnet-4-5:high')).toBe('openai/gpt-4.1-mini:low');
  });
});
