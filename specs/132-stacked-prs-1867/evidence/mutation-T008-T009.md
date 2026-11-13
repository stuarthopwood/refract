# Mutation rows T008-T009 (stack-view.ts; vitest stack-view.test.ts StackLayers.test.ts)
| Guard | Mutation | Result |
|---|---|---|
| feature-on gate | `return settingOn && state === 'ready'` -> `return settingOn` | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯  FAIL  src/renderer/features/pull-requests/stack-view.test.ts > stackFeatureOn > needs the toggle on and gh stack ready       Tests  1 failed | 14 passed (15)  |
| install-vs-layers choice | `state === 'missing' || state === 'outdated'` -> `false` | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯  FAIL  src/renderer/features/pull-requests/stack-view.test.ts > mergeDialogStack > offers Install while gh stack cannot merge the stack       Tests  1 failed | 14 passed (15)  |
| stackHint choice | `featureOn && position ? 'stacked' : 'plain'` -> `position ? 'stacked' : 'plain'` | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯  FAIL  src/renderer/features/pull-requests/stack-view.test.ts > mergeInputFor > sends plain when the feature is off, even for a stacked pull request       Tests  1 failed | 14 passed (15)  |
| position mapping (open) | `state: 'open' as const` -> `state: 'merged' as const` |       Tests  15 passed (15)  |
| position mapping | `refs.map` -> `refs.slice(1).map` | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯  FAIL  src/renderer/features/pull-requests/stack-view.test.ts > stackPositionFor > maps each layer to its 1-based position, bottom first  FAIL  src/renderer/features/pull-requests/stack-view.test.ts > buildStackMap > chains each row against its own Project only  |

Note: mutating the `state: 'open'` stamp in stackPositionFor survived (15 pass) because chainFor ignores state; it is an equivalent mutant, not a guard.
