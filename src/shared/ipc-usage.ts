// Spec 060 (#1331) contracts/ipc.md: the Usage view's `usage.*` channels. Kept out of `ipc.ts`,
// which is at its file-size cap: `RefractApi` gains `usage` by module augmentation below, and
// `check-parity.mjs` reads `IPC_USAGE_REQUESTS` / `IPC_USAGE_EVENTS` from this file. Every result
// is aggregate or labelled metadata; none carries prompt prose.
import type { Result } from './ipc'

export const IPC_USAGE_REQUESTS = {
  USAGE_START: 'usage.start',
  USAGE_STOP: 'usage.stop',
  USAGE_STATUS: 'usage.status',
  USAGE_SUMMARY: 'usage.summary',
  USAGE_TIMESERIES: 'usage.timeseries',
  USAGE_TOKEN_MIX: 'usage.tokenMix',
  USAGE_BREAKDOWN: 'usage.breakdown',
  USAGE_TOP_SESSIONS: 'usage.topSessions',
  USAGE_CALLS: 'usage.calls',
  USAGE_FRUSTRATION: 'usage.frustration',
  USAGE_BUDGET: 'usage.budget',
  USAGE_GET_PREFS: 'usage.getPrefs',
  USAGE_SET_PREFS: 'usage.setPrefs'
} as const

export const IPC_USAGE_EVENTS = {
  USAGE_PROGRESS: 'usage:progress'
} as const

export type UsageRange = 'today' | '7d' | '30d' | 'all' | 'custom'

export interface UsageFilters {
  range: UsageRange
  /** Milliseconds since the epoch; `custom` only. */
  from?: number
  to?: number
  /** Project label. */
  project?: string | null
  model?: string | null
  reasoning?: string | null
  agentType?: 'main' | 'subagent' | null
}

export interface UsageStatus {
  running: boolean
  sessionsSeen: number
  sessionsDone: number
  sessionsDir: string
  found: boolean
}

export interface UsageSummary {
  spendUsd: number
  credits: number
  calls: number
  totalTokens: number
  cacheHitRate: number
  avgContextPerCall: number
  toolCalls: number
  toolErrorRate: number
}

export interface UsageTimeBucket {
  bucketStart: number
  byModel: { model: string; usd: number; credits: number }[]
}

export interface UsageTokenMixRow {
  type: 'input' | 'cacheWrite' | 'cacheRead' | 'output'
  tokens: number
  usd: number
  costShare: number
}

export type UsageBreakdownBy = 'project' | 'model' | 'tool'

export interface UsageBreakdownRow {
  label: string
  /** Model rows only. */
  reasoning?: string
  calls: number
  tokens: number
  usd: number
  credits: number
  /** Tool rows only. */
  errors?: number
  resultChars?: number
  costShare?: number
}

export interface UsageTopSession {
  sessionId: string
  label: string
  project: string
  usd: number
  credits: number
  calls: number
  /** True when the file is the Conversation of a Refract Session. */
  conversationKnown: boolean
}

export type UsageCallSortKey =
  | 'ts' | 'model' | 'project' | 'tokens' | 'usd' | 'credits' | 'input' | 'output'
  | 'cacheRead' | 'duration' | 'ttft'

export interface UsageCallRow {
  ts: number
  sessionId: string
  model: string
  reasoning: string
  project: string
  agentType: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  usd: number
  credits: number | null
  durationMs: number | null
  ttftMs: number | null
  stopReason: string | null
}

export interface UsageFrustration {
  yelling: number
  profanity: number
  blame: number
  messages: number
  daily: { day: string; mood: number }[]
}

export interface UsageBudget {
  copilot: {
    percentUsed: number
    creditsUsed: number | null
    entitlement: number | null
    remaining: number | null
    resetsAt: number
    burnPerDay: number | null
    capDate: number | null
  } | null
  providers: { provider: string; label: string; used: number; limit: number | null; unit: string; resetsAt: number | null }[]
  unavailable?: string
}

export interface UsagePrefs {
  jokes: boolean
  filters: UsageFilters
}

/**
 * `tzOffsetMinutes` is the value of `new Date().getTimezoneOffset()` (minutes WEST of UTC, so
 * UTC+1 is -60). It decides where "today" and the day buckets start. The Rust handler negates it
 * once (`ipc::usage::query_ctx`) into the minutes-east value `usage::queries::QueryCtx` uses.
 * Every query channel takes it as an optional last argument (absent or null means UTC); `today`
 * and day buckets are wrong without it. Allowed range: -840 to 840.
 */
export interface UsageApi {
  /** Starts the backfill and the five-minute rescan; idempotent. */
  start(): Promise<Result<UsageStatus>>
  /** Ends the rescan (the view closed); a running pass finishes. */
  stop(): Promise<Result<null>>
  status(): Promise<Result<UsageStatus>>
  summary(filters: UsageFilters, tzOffsetMinutes?: number): Promise<Result<UsageSummary>>
  timeseries(
    filters: UsageFilters,
    bucket: 'day' | 'hour',
    tzOffsetMinutes?: number
  ): Promise<Result<UsageTimeBucket[]>>
  tokenMix(filters: UsageFilters, tzOffsetMinutes?: number): Promise<Result<UsageTokenMixRow[]>>
  breakdown(
    filters: UsageFilters,
    by: UsageBreakdownBy,
    tzOffsetMinutes?: number
  ): Promise<Result<UsageBreakdownRow[]>>
  topSessions(filters: UsageFilters, tzOffsetMinutes?: number): Promise<Result<UsageTopSession[]>>
  /** `page.size` is 1 to 100; `sort.key` must be a `UsageCallSortKey`. */
  calls(
    filters: UsageFilters,
    sort: { key: UsageCallSortKey; dir: 'asc' | 'desc' },
    page: { index: number; size: number },
    tzOffsetMinutes?: number
  ): Promise<Result<{ rows: UsageCallRow[]; total: number }>>
  frustration(filters: UsageFilters, tzOffsetMinutes?: number): Promise<Result<UsageFrustration>>
  budget(): Promise<Result<UsageBudget>>
  getPrefs(): Promise<Result<UsagePrefs>>
  setPrefs(patch: { jokes?: boolean; filters?: UsageFilters }): Promise<Result<UsagePrefs>>
  /** Emitted at most once a second while an ingest runs, and once when it ends. */
  onProgress(handler: (status: UsageStatus) => void): () => void
}

declare module './ipc' {
  interface RefractApi {
    usage: UsageApi
  }
}
