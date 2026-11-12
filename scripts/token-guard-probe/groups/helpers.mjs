// Shared pieces for probe groups (#1935): scratch config nesting and the two-turn scripted-tool probe.
import { DEFAULT_MODEL_ID, sequence } from '../provider.mjs';
import { lastToolResultText } from '../observe.mjs';

/** `{ 'a.b': 1, 'c.d.e': 2 }` -> `{ a: { b: 1 }, c: { d: { e: 2 } } }`, the shape omp's config.yml stores. */
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

/**
 * Two turns that each end in the same scripted tool call; the key is edited between them. The observable is
 * `shape(last tool result)` in the request that follows each call, so only the tool's own output decides it.
 * @param {object} ctx           probe context from run.mjs
 * @param {object} o
 * @param {Record<string, unknown>} o.baseline  dotted keys seeded in config.yml (includes `key`)
 * @param {{name: string, args: object}} o.call
 * @param {Record<string, string>} [o.files]
 * @param {string} o.key
 * @param {unknown} o.value                     value written between the turns (test mode)
 * @param {(text: string | null) => unknown} o.shape
 */
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
