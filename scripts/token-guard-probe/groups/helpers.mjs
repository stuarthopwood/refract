// Probe-group helpers (#1935): config nesting and the two-turn tool-call probe.
import { DEFAULT_MODEL_ID, sequence } from '../provider.mjs';
import { lastToolResultText } from '../observe.mjs';

// Dotted keys to the nested shape omp's config.yml stores.
export function nest(entries) {
  const root = {};
  for (const [dotted, value] of Object.entries(entries)) {
    const parts = dotted.split('.');
    let at = root;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts[parts.length - 1]] = value;
  }
  return root;
}

// Why: omp's own prompt and tool schemas exceed the harness default 8k window and trigger compaction mid-probe.
export const ROOMY_MODELS = [{ id: DEFAULT_MODEL_ID, vision: true, contextWindow: 400_000 }];

// Two turns ending in the same scripted tool call, key edited between them; the observable is `shape` of the last tool result.
export async function toolCallTwice(ctx, { baseline, call, files, key, value, shape }) {
  const script = sequence([{ type: 'tool_call', ...call }, { type: 'text', text: 'one' }, { type: 'tool_call', ...call }, { type: 'text', text: 'two' }]);
  const { host, provider } = await ctx.start({ script, config: nest(baseline), models: ROOMY_MODELS, files });
  await host.prompt('turn one');
  await ctx.edit(host, key, value);
  await host.prompt('turn two');
  if (provider.requests.length !== 4) throw new Error(`expected 4 provider requests, saw ${provider.requests.length}`);
  const at = (i) => shape(lastToolResultText(provider.requests[i].body));
  return { before: at(1), after: at(3) };
}
