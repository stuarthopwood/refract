// Start-of-turn probes (#1935 T011): plan.defaultOnStartup, prewalk.enabled, todo.eager, each read on the turn after a mid-process edit.
import { sequence } from '../provider.mjs';
import { requestModelId, systemText } from '../observe.mjs';
import { nest, ROOMY_MODELS } from './helpers.mjs';

const PREWALK_MODELS = [...ROOMY_MODELS, { ...ROOMY_MODELS[0], id: 'probe-model-b' }];
const TODO_INIT = { type: 'tool_call', name: 'todo', args: { op: 'init', i: 'Planning', list: [{ phase: 'Probe', items: ['write a file'] }] } };
const WRITE_FILE = { type: 'tool_call', name: 'write', args: { path: 'out.txt', content: 'probe\n' } };

const allText = (body) => systemText(body) + JSON.stringify(body?.messages ?? []);
const toolNames = (body) => (body?.tools ?? []).map((t) => t.function?.name).join(',');

/** Runs `turns` prompts with a single scripted provider; the key is edited before turn 2. `read(requests)` gives the observable of one turn. */
async function twoTurns(ctx, { baseline, key, value, models = ROOMY_MODELS, script, read }) {
  const { host, provider } = await ctx.start({ script, config: nest(baseline), models });
  const marks = [];
  for (const turn of [1, 2]) {
    if (turn === 2) await ctx.edit(host, key, value);
    const first = provider.requests.length;
    await host.prompt(`turn ${turn}`);
    marks.push(read(provider.requests.slice(first)));
  }
  return { before: marks[0], after: marks[1] };
}

export const promptGroup = {
  description: 'plan.defaultOnStartup, prewalk.enabled and todo.eager, observed on the next turn of the same process',
  keys: [
    {
      key: 'plan.defaultOnStartup',
      observable: 'plan-mode marker in the turn\'s first request, plus the exposed tool names (RPC offers no way to enter plan mode, so any marker would come from the key)',
      run: (ctx) => twoTurns(ctx, {
        baseline: { 'plan.defaultOnStartup': false },
        key: 'plan.defaultOnStartup',
        value: true,
        script: sequence([], { type: 'text', text: 'ok' }),
        read: (reqs) => ({ planMode: /plan mode/i.test(allText(reqs[0]?.body)), tools: toolNames(reqs[0]?.body) }),
      }),
    },
    {
      key: 'prewalk.enabled',
      observable: 'model id of the last request in a turn that makes a todo then a write call (prewalk.into = probe-model-b), turn 1 (off) vs turn 2 (on)',
      run: (ctx) => {
        let step = 0;
        // Why: prewalk hands off at the first write once a todo exists, so each turn is todo, write, text.
        const script = () => [TODO_INIT, WRITE_FILE, { type: 'text', text: 'done' }][step++ % 3];
        return twoTurns(ctx, {
          baseline: { 'prewalk.enabled': false, 'prewalk.into': 'probe-mock/probe-model-b' },
          key: 'prewalk.enabled',
          value: true,
          models: PREWALK_MODELS,
          script,
          read: (reqs) => requestModelId(reqs[reqs.length - 1]?.body),
        });
      },
    },
    {
      key: 'todo.eager',
      observable: 'which eager-todo reminder ("always" / "preferred" / none) the turn\'s first request carries, turn 1 (default) vs turn 2 (always)',
      run: (ctx) => twoTurns(ctx, {
        baseline: { 'todo.eager': 'default' },
        key: 'todo.eager',
        value: 'always',
        script: sequence([], { type: 'text', text: 'ok' }),
        read(reqs) {
          const text = JSON.stringify(reqs[0]?.body?.messages ?? []);
          if (text.includes('create a phased todo')) return 'always';
          return text.includes('Consider calling `todo` first') ? 'preferred' : 'none';
        },
      }),
    },
  ],
};
