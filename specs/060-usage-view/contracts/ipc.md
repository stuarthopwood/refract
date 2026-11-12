# Contract 060: `usage.*` IPC

Types live in `src/shared/ipc-usage.ts` (not `ipc.ts`). All handlers return `Result<T>` like the other channels. Every result is aggregate or labelled metadata; none carries prompt prose.

```ts
export type UsageRange = 'today' | '7d' | '30d' | 'all' | 'custom'
export interface UsageFilters {
  range: UsageRange
  from?: number // ms, custom only
  to?: number
  project?: string | null // project label
  model?: string | null
  reasoning?: string | null
 agentType?: 'main' | 'subagent' | null
 sessionDir?: string | null // Session usage panel: every conversation file at or below this directory
 sessionFile?: string | null // Session usage panel: one conversation file (#1743)
}
export interface UsageStatus { running: boolean; sessionsSeen: number; sessionsDone: number; sessionsDir: string; found: boolean; scanCompleted: boolean }
```

| Channel | Args | Result |
| --- | --- | --- |
| `usage.start` | none | `UsageStatus`; ingest already runs from app launch (#1655), so this queues an incremental scan, which also retries a failed launch start; idempotent |
| `usage.status` | none | `UsageStatus` |
| `usage.summary` | `filters` | spend USD, credits, calls, total tokens, cache hit rate, avg context per call, tool calls, tool error rate, active days, sessions (distinct session files), month-to-date USD and month active days (month fields ignore the date range) |
| `usage.timeseries` | `filters, bucket: 'day'\|'hour', tzOffsetMinutes` | `{ bucketStart, byModel: {model, usd, credits}[] }[]` |
| `usage.tokenMix` | `filters` | `{ type: 'input'\|'cacheWrite'\|'cacheRead'\|'output', tokens, usd, costShare }[]` |
| `usage.breakdown` | `filters, by: 'project'\|'model'\|'tool'` | rows: label (and reasoning for model), calls, tokens, usd, credits; tools add errors, result chars, cost share (0 to 1, a fraction of the window's tool spend; absent when no tool call was priced) |
| `usage.topSessions` | `filters` | ten rows: sessionId, label, project, usd, credits, calls, `conversationKnown` |
| `usage.calls` | `filters, sort: {key, dir}, page: {index, size<=100}` | `{ rows, total }`; `key` from an allowlist |
| `usage.frustration` | `filters` | `{ yelling, profanity, blame, messages, daily: {day, mood}[] }` |
| `usage.budget` | none | `{ copilot: {percentUsed, creditsUsed, entitlement, remaining, resetsAt, burnPerDay, capDate} \| null, providers: {provider, label, used, limit, unit, resetsAt}[], unavailable?: string }` |
| `usage.getPrefs` | none | `{ jokes: boolean, filters: UsageFilters, sessionScope: 'session' \| 'conversation', sessionRange: 'all' \| 'today' }` |
| `usage.setPrefs` | `{ jokes?, filters?, sessionScope?, sessionRange? }` | the new prefs; `sessionScope` / `sessionRange` outside the allowlist is `invalid-argument` |

Event `usage.progress` (`UsageStatus`) is emitted at most once a second while an ingest runs, and once when it ends.

Errors: `invalid-argument` (bad sort key, page size, range), `usage-db-unavailable` (open or rebuild failed; the view shows the reason). A filter value that matches nothing returns empty rows, not an error.

Internal, not a channel: the worker's nudge (a Session's file path from the registry, never from the renderer) and the relabel step run on `usage.start`.
