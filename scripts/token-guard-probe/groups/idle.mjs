// Idle compaction probes (#1935 T013): the three compaction.idle* keys. omp enables its idle scheduler only for the interactive TUI,
// so the expected result is that nothing ever fires in an RPC session; these probes record that instead of assuming it.
import { sequence } from '../provider.mjs';
import { nest, ROOMY_MODELS } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Why: omp's minimum idle timeout is 60s, so the wait has to outlast it by a margin.
const IDLE_WAIT_MS = 75_000;
const ARMED = { 'compaction.idleEnabled': true, 'compaction.idleThresholdTokens': 1000, 'compaction.idleTimeoutSeconds': 60 };

/** Observable: provider requests and compaction frames that appear while the settled session sits idle after each turn. */
async function idleTwice(ctx, { baseline, key, value }) {
  const { host, provider } = await ctx.start({ script: sequence([], { type: 'text', text: 'ok' }), config: nest(baseline), models: ROOMY_MODELS });
  const marks = [];
  for (const turn of [1, 2]) {
    if (turn === 2) await ctx.edit(host, key, value);
    await host.prompt(`turn ${turn}`);
    const requests = provider.requests.length;
    const frames = host.frames.length;
    await sleep(IDLE_WAIT_MS);
    const idleFrames = host.frames.slice(frames).filter((r) => /compact/i.test(JSON.stringify(r.frame)));
    marks.push({ idleRequests: provider.requests.length - requests, idleCompactionFrames: idleFrames.length });
  }
  return { before: marks[0], after: marks[1] };
}

const idleKey = (key, off, on) => ({
  key,
  observable: 'provider requests and compaction frames during a 75 s idle wait after a settled turn, turn 1 (key off/inert) vs turn 2 (key armed)',
  run: (ctx) => idleTwice(ctx, { baseline: { ...ARMED, [key]: off }, key, value: on }),
});

export const idleGroup = {
  description: 'compaction.idleEnabled, idleThresholdTokens and idleTimeoutSeconds, observed as post-turn idle activity',
  keys: [
    idleKey('compaction.idleEnabled', false, true),
    idleKey('compaction.idleThresholdTokens', 100_000_000, 1000),
    idleKey('compaction.idleTimeoutSeconds', 3600, 60),
  ],
};
