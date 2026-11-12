// Probe group registry (#1935). A group is `{ description, smoke?, keys: [{ key, observable, run }] }`.
// `run(ctx)` returns `{ before, after }`: the observable on turn one and on turn two. `ctx.mode` is `control`
// (no edit) or `test`; always edit through `ctx.edit` so both modes wait the same time between turns.
import { sequence } from './provider.mjs';
import { requestModelId } from './observe.mjs';
import { artifactSpillGroup, toolResultsGroup } from './groups/toolOutput.mjs';
import { snapcompactGroup } from './groups/snapcompact.mjs';
import { subagentGroup } from './groups/subagents.mjs';
import { promptGroup } from './groups/prompt.mjs';

export const GROUPS = {
  // Why: exercises provider, host, edit and A/B end to end with a key that cannot change the model id.
  smoke: {
    description: 'harness self-check: model id of two turns, with an unrelated key edited between them',
    smoke: true,
    keys: [
      {
        key: 'smoke.modelIdStable',
        observable: 'request model id, turn 1 vs turn 2',
        async run(ctx) {
          const { host, provider } = await ctx.start({ script: sequence([], { type: 'text', text: 'ok' }) });
          await host.prompt('turn one');
          await ctx.edit(host, 'compaction.idleEnabled', true);
          await host.prompt('turn two');
          const [first, second] = provider.requests;
          return { before: requestModelId(first?.body), after: requestModelId(second?.body) };
        },
      },
    ],
  },
  'tool-results': toolResultsGroup,
  'artifact-spill': artifactSpillGroup,
  snapcompact: snapcompactGroup,
  subagents: subagentGroup,
  prompt: promptGroup,
};
