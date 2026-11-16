import { describe, expect, it } from 'vitest';
import { classifyRun, deriveVerdict, OUTCOMES, VERDICTS } from './ab.mjs';

const pass = (before, after) => ({ before, after });
const changedRun = { control: pass(1, 1), test: pass(1, 2) };
const unchangedRun = { control: pass(1, 1), test: pass(1, 1) };

describe('classifyRun', () => {
  it('reports changed when only the test run moves', () => {
    expect(classifyRun(changedRun).outcome).toBe(OUTCOMES.CHANGED);
  });

  it('reports unchanged when neither run moves', () => {
    expect(classifyRun(unchangedRun).outcome).toBe(OUTCOMES.UNCHANGED);
  });

  it('reports an unstable control when the no-edit run changes', () => {
    const run = { control: pass(1, 2), test: pass(1, 2) };
    expect(classifyRun(run).outcome).toBe(OUTCOMES.CONTROL_UNSTABLE);
  });

  it('reports an unstable control when baselines differ between control and test', () => {
    const run = { control: pass(1, 1), test: pass(5, 6) };
    expect(classifyRun(run).outcome).toBe(OUTCOMES.CONTROL_UNSTABLE);
  });

  it('reports no observable when a value is missing', () => {
    expect(classifyRun({ control: pass(1, 1), test: pass(1, undefined) }).outcome).toBe(OUTCOMES.NO_OBSERVABLE);
    expect(classifyRun({ control: pass(null, 1), test: pass(1, 1) }).outcome).toBe(OUTCOMES.NO_OBSERVABLE);
    expect(classifyRun({ control: pass(1, 1) }).outcome).toBe(OUTCOMES.NO_OBSERVABLE);
  });

  it('compares structured observables by value', () => {
    const run = { control: pass({ peak: 1 }, { peak: 1 }), test: pass({ peak: 1 }, { peak: 3 }) };
    expect(classifyRun(run).outcome).toBe(OUTCOMES.CHANGED);
  });

  it('treats zero and false as real observations, not missing ones', () => {
    expect(classifyRun({ control: pass(0, 0), test: pass(0, 0) }).outcome).toBe(OUTCOMES.UNCHANGED);
    expect(classifyRun({ control: pass(false, false), test: pass(false, true) }).outcome).toBe(OUTCOMES.CHANGED);
  });
});

describe('deriveVerdict', () => {
  it('is live when two consecutive runs both changed', () => {
    expect(deriveVerdict([changedRun, changedRun]).verdict).toBe(VERDICTS.LIVE);
  });

  it('is startup-only when two consecutive runs both stayed unchanged', () => {
    expect(deriveVerdict([unchangedRun, unchangedRun]).verdict).toBe(VERDICTS.STARTUP_ONLY);
  });

  it('is inconclusive for a single run, never live', () => {
    expect(deriveVerdict([changedRun]).verdict).toBe(VERDICTS.INCONCLUSIVE);
    expect(deriveVerdict([]).verdict).toBe(VERDICTS.INCONCLUSIVE);
    expect(deriveVerdict(undefined).verdict).toBe(VERDICTS.INCONCLUSIVE);
  });

  it('is inconclusive when a control is flaky in either run', () => {
    const flaky = { control: pass(1, 2), test: pass(1, 2) };
    const result = deriveVerdict([changedRun, flaky]);
    expect(result.verdict).toBe(VERDICTS.INCONCLUSIVE);
    expect(result.reason).toMatch(/control/);
  });

  it('is inconclusive when a disagreeing pair of runs is seen', () => {
    const result = deriveVerdict([changedRun, unchangedRun]);
    expect(result.verdict).toBe(VERDICTS.INCONCLUSIVE);
    expect(result.reason).toBe('runs disagree');
    expect(result.outcomes).toEqual([OUTCOMES.CHANGED, OUTCOMES.UNCHANGED]);
  });

  it('is inconclusive when any run has no observable', () => {
    const none = { control: pass(1, 1), test: pass(1, undefined) };
    expect(deriveVerdict([unchangedRun, none]).verdict).toBe(VERDICTS.INCONCLUSIVE);
  });

  it('keeps live only if every run supplied agrees, including a third', () => {
    expect(deriveVerdict([changedRun, changedRun, unchangedRun]).verdict).toBe(VERDICTS.INCONCLUSIVE);
  });
});
