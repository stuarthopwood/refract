// Background-review probes (#1935 T012): autolearn.autoContinue and advisor.reviewMode, each read on the turn after a mid-process edit.
import { nest, ROOMY_MODELS } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADVISOR_MODEL = 'probe-model-b';
const MODELS = [...ROOMY_MODELS, { ...ROOMY_MODELS[0], id: ADVISOR_MODEL }];
const READ_CALLS = 3;
// Why: advisor and capture requests arrive after the turn settles; wait for them instead of racing the count.
const LATE_REQUEST_MS = 4000;

const isCaptureTurn = (msg) => JSON.stringify(msg?.content ?? '').includes('Automated capture turn');

/** Primary: read f.txt READ_CALLS times then finish; capture turns and the advisor model just answer with text. */
function primaryScript(rec) {
  const { model, messages = [] } = rec.body;
  if (model === ADVISOR_MODEL) return { type: 'text', text: 'no concerns' };
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (isCaptureTurn(messages[lastUser])) return { type: 'text', text: 'nothing to capture' };
  const reads = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
  return reads < READ_CALLS ? { type: 'tool_call', name: 'read', args: { path: 'f.txt' } } : { type: 'text', text: 'done' };
}

/** Two turns of the same scripted work; `count(requests)` is the observable of one turn. */
async function twoTurns(ctx, { baseline, key, value, count }) {
  const { host, provider } = await ctx.start({ script: primaryScript, config: nest(baseline), models: MODELS, files: { 'f.txt': 'x\n' } });
  const marks = [];
  for (const turn of [1, 2]) {
    if (turn === 2) await ctx.edit(host, key, value);
    const first = provider.requests.length;
    await host.prompt(`turn ${turn}`);
    await sleep(LATE_REQUEST_MS);
    marks.push(count(provider.requests.slice(first)));
  }
  return { before: marks[0], after: marks[1] };
}

export const reviewGroup = {
  description: 'autolearn.autoContinue and advisor.reviewMode, observed as extra requests on the next turn of the same process',
  keys: [
    {
      key: 'autolearn.autoContinue',
      observable: 'requests that carry the automated capture prompt after a turn of 3 tool calls, turn 1 (off) vs turn 2 (on)',
      run: (ctx) => twoTurns(ctx, {
        baseline: { 'autolearn.enabled': true, 'autolearn.minToolCalls': 1, 'autolearn.autoContinue': false },
        key: 'autolearn.autoContinue',
        value: true,
        count: (reqs) => reqs.filter((r) => isCaptureTurn(r.body.messages[r.body.messages.length - 1])).length,
      }),
    },
    {
      key: 'advisor.reviewMode',
      observable: 'requests sent to the advisor model during a turn of 3 tool calls, turn 1 (turn) vs turn 2 (agent-end)',
      run: (ctx) => twoTurns(ctx, {
        baseline: { 'advisor.enabled': true, 'modelRoles.advisor': `probe-mock/${ADVISOR_MODEL}`, 'advisor.reviewMode': 'turn' },
        key: 'advisor.reviewMode',
        value: 'agent-end',
        count: (reqs) => reqs.filter((r) => r.body.model === ADVISOR_MODEL).length,
      }),
    },
  ],
};
