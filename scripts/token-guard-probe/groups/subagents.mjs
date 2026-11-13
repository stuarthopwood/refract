// Subagent probes (#1935 T010): a scripted parent spawns background `task` subagents against the scripted provider.
import { startProvider } from '../provider.mjs';
import { nest, ROOMY_MODELS } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Why: omp's parent agent has the `ask` tool and subagents do not; that is the only stable way to tell their requests apart.
const isSubRequest = (rec) => !(rec.body?.tools ?? []).some((t) => t.function?.name === 'ask');
const SUBTASKS = [1, 2, 3].map((n) => ({ task: `Probe subtask ${n}: do nothing`, solutionSpace: 'trivial', name: `Sub${n}` }));
const TASK_CALL = { type: 'tool_call', name: 'task', args: { context: 'probe', i: 'Probing subagents', tasks: SUBTASKS } };

/** Waits until no request is parked, nothing new has arrived for `quietMs`, and `done` has settled. */
async function drain(provider, done, quietMs = 2500, capMs = 90_000) {
  let settled = false;
  done.then(() => (settled = true), () => (settled = true));
  const start = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() - start < capMs) {
    provider.release();
    await sleep(300);
    if (provider.requests.length !== lastCount) {
      lastCount = provider.requests.length;
      quietSince = Date.now();
    }
    if (settled && provider.heldCount() === 0 && Date.now() - quietSince > quietMs) return;
  }
  throw new Error('subagent turn did not drain');
}

/**
 * Two turns, each spawning three subagents. `subStep(n)` is the scripted reply to a subagent's n-th request
 * (1-based, per subagent); `measure(subRecords, provider)` reads the observable for one turn.
 */
async function subagentTwice(ctx, { baseline, key, value, subStep, measure }) {
  const state = { spawn: false };
  const perAgent = new Map();
  const script = (rec) => {
    if (!isSubRequest(rec)) {
      if (!state.spawn) return { type: 'text', text: 'parent done' };
      state.spawn = false;
      return TASK_CALL;
    }
    const agent = JSON.stringify(rec.body.messages?.[1] ?? rec.body.messages?.[0]).match(/Probe subtask (\d)/)?.[1] ?? '?';
    const id = `${state.turn}:${agent}`;
    perAgent.set(id, (perAgent.get(id) ?? 0) + 1);
    return subStep(perAgent.get(id));
  };
  const { host, provider } = await ctx.start({ script, config: nest(baseline), models: ROOMY_MODELS, files: { 'f.txt': 'probe file\n' } });
  const marks = [];
  for (const turn of [1, 2]) {
    if (turn === 2) await ctx.edit(host, key, value);
    state.turn = turn;
    state.spawn = true;
    const first = provider.requests.length;
    const done = host.prompt(`turn ${turn}`);
    marks.push(await measure({ provider, done, first }));
  }
  return { before: marks[0], after: marks[1] };
}

// Why: peak is read only after the first subagent request is parked and then holds steady, so a slow spawn cannot read as 0.
const PEAK_STABLE_MS = 3000;
const PEAK_CAP_MS = 60_000;

export const subagentGroup = {
  description: 'task.maxConcurrency and task.softRequestBudget, observed on scripted background subagents',
  keys: [
    {
      key: 'task.maxConcurrency',
      observable: 'peak parked subagent requests of 3 spawned subagents, turn 1 (limit 1) vs turn 2 (limit 3)',
      run: (ctx) => subagentTwice(ctx, {
        baseline: { 'task.maxConcurrency': 1 },
        key: 'task.maxConcurrency',
        value: 3,
        subStep: () => ({ type: 'hold', then: { type: 'text', text: 'sub done' } }),
        async measure({ provider, done, first }) {
          let peak = 0;
          let changedAt = Date.now();
          const start = Date.now();
          while (Date.now() - start < PEAK_CAP_MS) {
            const now = provider.requests.slice(first).filter((r) => r.held && isSubRequest(r)).length;
            if (now > peak) {
              peak = now;
              changedAt = Date.now();
            }
            if (peak > 0 && Date.now() - changedAt > PEAK_STABLE_MS) break;
            await sleep(100);
          }
          await drain(provider, done);
          return peak;
        },
      }),
    },
    {
      key: 'task.softRequestBudget',
      observable: 'requests the 3 never-finishing subagents make before force-stop, turn 1 (budget 2) vs turn 2 (budget 6)',
      run: (ctx) => subagentTwice(ctx, {
        baseline: { 'task.softRequestBudget': 2, 'task.softRequestBudgetNotice': true },
        key: 'task.softRequestBudget',
        value: 6,
        // Why: a subagent that never finishes on its own, so only the budget can stop it; capped so a no-effect key still ends.
        subStep: (n) => (n > 40 ? { type: 'text', text: 'gave up' } : { type: 'tool_call', name: 'read', args: { path: 'f.txt' } }),
        async measure({ provider, done, first }) {
          await drain(provider, done, 4000);
          return provider.requests.slice(first).filter(isSubRequest).length;
        },
      }),
    },
  ],
};
