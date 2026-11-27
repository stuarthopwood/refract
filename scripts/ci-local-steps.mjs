// The pure half of `scripts/ci-local.mjs`, kept apart from the CLI so tests can import it: the CLI file
// starts with a shebang, which Vite's module runner breaks on when a Windows checkout gives it CRLF endings.
import yaml from 'js-yaml';

const DEFAULT_WORKFLOW_REL = '.github/ci-local.yml';

// Strict parse: an unknown job/step key (`env`, `if`, `strategy`, `working-directory`, ...) changes execution
// semantics ci-local does not implement, so it must fail loudly rather than diverge silently from Actions.
const ALLOWED_JOB_KEYS = new Set(['name', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);
const ALLOWED_STEP_KEYS = new Set(['name', 'run', 'uses', 'with', 'id']);

export function parseSteps(raw, workflowRel = DEFAULT_WORKFLOW_REL) {
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new Error(`failed to parse ${workflowRel}: ${err.message}`);
  }
  if (doc == null || typeof doc !== 'object' || doc.jobs == null || typeof doc.jobs !== 'object') {
    throw new Error(`${workflowRel} has no top-level "jobs" map`);
  }

  const steps = [];
  for (const [jobName, job] of Object.entries(doc.jobs)) {
    if (job == null || !Array.isArray(job.steps)) {
      throw new Error(`${workflowRel}: job "${jobName}" has no "steps" array`);
    }
    for (const key of Object.keys(job)) {
      if (!ALLOWED_JOB_KEYS.has(key)) {
        throw new Error(
          `${workflowRel}: job "${jobName}" has a "${key}:" key ci-local.mjs does not understand ` +
            '-- it may change execution semantics locally without error',
        );
      }
    }
    job.steps.forEach((step, i) => {
      const where = `job "${jobName}" step ${i + 1}`;
      if (step == null || typeof step !== 'object') {
        throw new Error(`${workflowRel}: ${where} is not a mapping`);
      }
      for (const key of Object.keys(step)) {
        if (!ALLOWED_STEP_KEYS.has(key)) {
          throw new Error(
            `${workflowRel}: ${where} ("${step.name ?? '(unnamed)'}") has a "${key}:" key ` +
              'ci-local.mjs does not understand -- it may change execution semantics locally without error',
          );
        }
      }
      if (step.run == null) {
        return; // a `uses:` step (checkout/toolchain setup) -- nothing to run locally.
      }
      if (typeof step.run !== 'string') {
        throw new Error(`${workflowRel}: ${where} ("${step.name ?? '(unnamed)'}") has a non-string "run:"`);
      }
      // A multi-line run is unexpected; fail rather than flatten it into several commands.
      if (step.run.includes('\n')) {
        throw new Error(
          `${workflowRel}: ${where} ("${step.name ?? '(unnamed)'}") has a multi-line "run:", ` +
            'which ci-local.mjs does not support',
        );
      }
      // The runner substitutes `${{ }}` before the shell sees it; run unexpanded it would diverge from CI.
      if (step.run.includes('${{')) {
        throw new Error(
          `${workflowRel}: ${where} ("${step.name ?? '(unnamed)'}") has a "\${{ ... }}" GitHub ` +
            'Actions expression in its "run:", which ci-local.mjs cannot evaluate locally',
        );
      }
      steps.push({ job: jobName, name: step.name ?? step.run, run: step.run });
    });
  }

  if (steps.length === 0) {
    throw new Error(`${workflowRel} has no steps with a "run:" command`);
  }
  return steps;
}

export function formatStepList(steps) {
  return steps.map((step, i) => `${String(i + 1).padStart(2)}. ${step.name} :: ${step.run}`);
}

// Returns true when `--list` was given and the steps were printed, so the caller stops before running any.
export function printListIfRequested(argv, steps, log) {
  if (!argv.includes('--list')) {
    return false;
  }
  formatStepList(steps).forEach((line) => log(line));
  return true;
}
