// Snapcompact probes (#1935 T009): the observable is whether the request carries image parts for the imaged content.
import { sequence } from '../provider.mjs';
import { imagePartCount } from '../observe.mjs';
import { nest } from './helpers.mjs';

// Why: omp only images the system prompt for model ids it knows as image-capable lineages; the scripted id is not one.
const IMAGING_MODELS = [{ id: 'claude-opus-4-5', vision: true, contextWindow: 400_000 }];
const AGENTS_MD = `# Project rules\n${Array.from({ length: 600 }, (_, i) => `Rule ${i}: keep functions small and tested.`).join('\n')}\n`;
const BIG_OUTPUT = { name: 'bash', args: { command: `node -e "process.stdout.write('abcdefghi\\\\n'.repeat(4500))"` } };

const imaged = (body) => (imagePartCount(body) > 0 ? 'images' : 'text only');

/** Turn 1 runs with the key at `baseline`, turn 2 after the edit; the observable is the last request of each turn. */
async function twoTurns(ctx, { baseline, key, value, steps, files }) {
  const { host, provider } = await ctx.start({ script: sequence(steps), config: nest(baseline), models: IMAGING_MODELS, files });
  const marks = [];
  for (const prompt of ['turn one', 'turn two']) {
    if (marks.length === 1) await ctx.edit(host, key, value);
    await host.prompt(prompt);
    marks.push(imaged(provider.requests.at(-1)?.body));
  }
  return { before: marks[0], after: marks[1] };
}

const toolSteps = [{ type: 'tool_call', ...BIG_OUTPUT }, { type: 'text', text: 'one' }, { type: 'tool_call', ...BIG_OUTPUT }, { type: 'text', text: 'two' }];

export const snapcompactGroup = {
  description: 'snapcompact imaging of tool results and of the system prompt, observed as image parts in the request',
  keys: [
    {
      key: 'snapcompact.toolResults',
      observable: 'image parts in the request that carries a ~40 KB bash result, turn 1 (off) vs turn 2 (on)',
      run: (ctx) => twoTurns(ctx, { baseline: { 'snapcompact.toolResults': false }, key: 'snapcompact.toolResults', value: true, steps: toolSteps }),
    },
    {
      key: 'snapcompact.systemPrompt',
      observable: 'image parts in the request, turn 1 (none) vs turn 2 (all), with a large AGENTS.md',
      run: (ctx) => twoTurns(ctx, {
        baseline: { 'snapcompact.systemPrompt': 'none' },
        key: 'snapcompact.systemPrompt',
        value: 'all',
        steps: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
        files: { 'AGENTS.md': AGENTS_MD },
      }),
    },
  ],
};
