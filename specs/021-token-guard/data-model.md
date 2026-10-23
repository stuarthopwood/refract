# Data model: Token guard

## TokenGuardValues (persisted, `token-guard.json`)
| Field | Type | Default |
|---|---|---|
| `version` | number | 1 |
| `compaction.modelThresholds` | record model -> number | Opus 5.5 200000; Sonnet 5.5, Sonnet 5, Haiku 5.5 120000; Gemini 4 Argon, GPT-5.6 Terra 150000 |
| `compaction.thresholdTokens` | number | 200000 |
| `compaction.idleEnabled` | boolean | true |
| `compaction.idleThresholdTokens` | number | 80000 |
| `compaction.idleTimeoutSeconds` | number | 240 |
| `compaction.methodOrder` | string list | snapcompact, shake, handoff, soft |
| `snapcompact.toolResults` | boolean | true |
| `snapcompact.systemPrompt` | string | none |
| `task.softRequestBudget` | number | 80 |
| `task.maxConcurrency` | number | 6 |
| `autolearn.autoContinue` | boolean | false |
| `advisor.reviewMode` | string | agent-end |
| `modelRoles.advisor` | string | github-copilot/gemini-4-argon:auto |
| `grep.contextBefore` / `grep.contextAfter` | number | 0 / 1 |
| `read.defaultLimit` | number | 200 |
| `tools.artifactSpillThreshold` | number | 30 |
| `tools.xdev` | boolean | true |

Validation: numbers are non-negative integers; strings non-empty; the model threshold record keys are non-empty. Invalid stored values fall back to the default for that key. Reset to default restores one key.

## Overlay file (`token-guard-overlay.yml`)
Generated, never edited by hand. Nested YAML of the values above with a leading comment `# refract-overlay-version: 1`. Written atomically (temp + rename) on every launch.

## ConversationCallCount (in memory, per Session and Conversation)
`{ sessionId, conversationId, calls, bannerDismissedAtCalls | null, announced300, announced500 }`. Reset on a new Conversation; re-derived from history on open or resume. Thresholds: 300 (readout), 500 (banner), re-show after dismissal at +100; shake above 60000 context tokens.

## Shake attempt (in memory, per Session)
`{ inFlight: boolean, lastAttemptSettleId }`: at most one per settle; the next prompt awaits `inFlight` (bounded timeout).
