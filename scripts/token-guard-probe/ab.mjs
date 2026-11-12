// Pure A/B verdict logic for the token guard live probes (#1935). A "run" is one control and one test
// pass; each pass records the same observable before and after the mid-process config edit.

export const VERDICTS = Object.freeze({
  LIVE: 'live',
  STARTUP_ONLY: 'startup-only',
  INCONCLUSIVE: 'inconclusive-startup-only',
});

export const OUTCOMES = Object.freeze({
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
  CONTROL_UNSTABLE: 'control-unstable',
  NO_OBSERVABLE: 'no-observable',
});

// Why: observables are plain JSON (numbers, strings, booleans, arrays); stringify gives structural equality.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = (v) => v === undefined || v === null;

/**
 * Classifies one run. `control` keeps the key's first value across both turns; `test` edits it between turns.
 * @param {{control: {before: unknown, after: unknown}, test: {before: unknown, after: unknown}}} run
 * @returns {{outcome: string, reason: string}}
 */
export function classifyRun(run) {
  const passes = [run?.control, run?.test];
  if (passes.some((p) => !p || missing(p.before) || missing(p.after))) {
    return { outcome: OUTCOMES.NO_OBSERVABLE, reason: 'a pass did not record the observable' };
  }
  const { control, test } = run;
  if (!same(control.before, control.after)) {
    return { outcome: OUTCOMES.CONTROL_UNSTABLE, reason: 'observable changed in the no-edit control run' };
  }
  // Why: a test baseline that differs from the control baseline means the marker is not reproducible between runs.
  if (!same(control.before, test.before)) {
    return { outcome: OUTCOMES.CONTROL_UNSTABLE, reason: 'test baseline differs from control baseline' };
  }
  return same(test.before, test.after)
    ? { outcome: OUTCOMES.UNCHANGED, reason: 'observable unchanged after the edit' }
    : { outcome: OUTCOMES.CHANGED, reason: 'observable changed after the edit and not in the control' };
}

/**
 * FR-003: a key is `live` only if at least two consecutive runs agree it changed. Any run without a usable
 * observable, with an unstable control, or that disagrees with another run downgrades to inconclusive.
 * @param {Array<{control: object, test: object}>} runs
 * @returns {{verdict: string, reason: string, outcomes: string[]}}
 */
export function deriveVerdict(runs) {
  const classified = (runs ?? []).map(classifyRun);
  const outcomes = classified.map((c) => c.outcome);
  if (classified.length < 2) {
    return { verdict: VERDICTS.INCONCLUSIVE, reason: 'fewer than two consecutive runs', outcomes };
  }
  const bad = classified.find((c) => c.outcome === OUTCOMES.NO_OBSERVABLE || c.outcome === OUTCOMES.CONTROL_UNSTABLE);
  if (bad) return { verdict: VERDICTS.INCONCLUSIVE, reason: bad.reason, outcomes };
  if (new Set(outcomes).size > 1) {
    return { verdict: VERDICTS.INCONCLUSIVE, reason: 'runs disagree', outcomes };
  }
  return outcomes[0] === OUTCOMES.CHANGED
    ? { verdict: VERDICTS.LIVE, reason: classified[0].reason, outcomes }
    : { verdict: VERDICTS.STARTUP_ONLY, reason: classified[0].reason, outcomes };
}
