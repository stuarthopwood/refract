// Per-Session usage for the right-pane Session usage panel (spec 070 FR-4, spec 123). Results are
// keyed by Session directory, Conversation (when scoped to one) and range, so switching panes or
// toggles never shows another scope's figures. Separate from `useUsageStore`: the dashboard's
// filters and results must not move when this panel does.
import { create } from 'zustand'
import type {
  UsageBreakdownRow,
  UsageBudget,
  UsageCallRow,
  UsageFilters,
  UsageSessionRange,
  UsageSessionScope,
  UsageStatus,
  UsageSummary,
  UsageTimeBucket,
  UsageTokenMixRow
} from '../../shared/ipc-usage'

export const SESSION_CALLS_STEP = 10
export const MAX_CALLS = 100

export interface SessionUsageEntry {
  summary: UsageSummary | null
  timeseries: UsageTimeBucket[]
  tokenMix: UsageTokenMixRow[]
  byModel: UsageBreakdownRow[]
  byTool: UsageBreakdownRow[]
  calls: UsageCallRow[]
  callsTotal: number
  callsLimit: number
  /** Spend in the current Copilot credit period, or null when the period is unknown. */
  periodCredits: number | null
  error: string | null
  loaded: boolean
}

/** The focused Session; `sessionFile` is its current Conversation file, or null before the first one. */
export interface SessionUsageTarget {
  sessionDir: string
  sessionFile: string | null
}

interface SessionUsageState {
  status: UsageStatus | null
  budget: UsageBudget | null
  /** The remembered toggle choices; `scope` may read 'conversation' while no Conversation exists. */
  scope: UsageSessionScope
  range: UsageSessionRange
  entries: Record<string, SessionUsageEntry>
  start(): Promise<void>
  stop(): void
  refresh(target: SessionUsageTarget): Promise<void>
  showMore(target: SessionUsageTarget): void
  setScope(scope: UsageSessionScope): void
  setRange(range: UsageSessionRange): void
}

const EMPTY: SessionUsageEntry = {
  summary: null,
  timeseries: [],
  tokenMix: [],
  byModel: [],
  byTool: [],
  calls: [],
  callsTotal: 0,
  callsLimit: SESSION_CALLS_STEP,
  periodCredits: null,
  error: null,
  loaded: false
}

/** Conversation scope needs a Conversation file; without one the panel falls back to the Session. */
export function effectiveScope(scope: UsageSessionScope, target: SessionUsageTarget): UsageSessionScope {
  return scope === 'conversation' && target.sessionFile ? 'conversation' : 'session'
}

export function entryKey(target: SessionUsageTarget, scope: UsageSessionScope, range: UsageSessionRange): string {
  const file = effectiveScope(scope, target) === 'conversation' ? target.sessionFile : ''
  return `${target.sessionDir}\n${file}\n${range}`
}

/** One calendar month before the reset instant, clamping a day that does not exist (31 Mar to 28 Feb). */
export function periodStart(resetsAt: number): number {
  const reset = new Date(resetsAt)
  const start = new Date(reset)
  start.setDate(1)
  start.setMonth(start.getMonth() - 1)
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
  start.setDate(Math.min(reset.getDate(), lastDay))
  return start.getTime()
}

let sequence = 0
let unsubscribe: (() => void) | null = null
let watchedTarget: SessionUsageTarget | null = null
let lastProgress: Pick<UsageStatus, 'running' | 'sessionsDone' | 'sessionsSeen'> | null = null
let trailing: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let dirty = false
let prefsLoad: Promise<void> | null = null
const REFRESH_THROTTLE_MS = 1500

/** Trailing-throttled refresh: at most one in flight, one more queued when progress arrived meanwhile. */
function scheduleRefresh(refresh: (target: SessionUsageTarget) => Promise<void>): void {
  if (inFlight) {
    dirty = true
    return
  }
  if (trailing) return
  trailing = setTimeout(() => {
    trailing = null
    if (!watchedTarget) return
    inFlight = true
    void refresh(watchedTarget).finally(() => {
      inFlight = false
      if (dirty) {
        dirty = false
        scheduleRefresh(refresh)
      }
    })
  }, REFRESH_THROTTLE_MS)
}

export const useSessionUsageStore = create<SessionUsageState>((set, get) => {
  // Reads the remembered toggles once; a failed read keeps the defaults rather than blocking figures.
  const loadPrefs = (): Promise<void> => {
    prefsLoad ??= window.refract.usage.getPrefs().then((result) => {
      if (result.ok) set({ scope: result.value.sessionScope, range: result.value.sessionRange })
    })
    return prefsLoad
  }
  const persist = (patch: { sessionScope?: UsageSessionScope; sessionRange?: UsageSessionRange }): void => {
    void window.refract.usage.setPrefs(patch)
    if (watchedTarget) void get().refresh(watchedTarget)
  }
  return {
    status: null,
    budget: null,
    scope: 'session',
    range: 'all',
    entries: {},
    async start() {
      unsubscribe?.()
      lastProgress = null
      unsubscribe = window.refract.usage.onProgress((status) => {
        const same =
          lastProgress?.running === status.running &&
          lastProgress.sessionsDone === status.sessionsDone &&
          lastProgress.sessionsSeen === status.sessionsSeen
        lastProgress = status
        if (!same) set({ status })
        if (watchedTarget) scheduleRefresh(get().refresh)
      })
      const started = await window.refract.usage.start()
      if (started.ok) set({ status: started.value })
      const budget = await window.refract.usage.budget()
      if (budget.ok) set({ budget: budget.value })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
      watchedTarget = null
      if (trailing) clearTimeout(trailing)
      trailing = null
      dirty = false
      sequence += 1
    },
    async refresh(target) {
      watchedTarget = target
      await loadPrefs()
      if (watchedTarget !== target) return
      sequence += 1
      const mine = sequence
      const api = window.refract.usage
      // Same value the Usage view sends, so "Today" lands on the same local-day boundary.
      const offset = new Date().getTimezoneOffset()
      const { scope, range } = get()
      const key = entryKey(target, scope, range)
      const base: UsageFilters = { range: 'all', sessionDir: target.sessionDir }
      if (effectiveScope(scope, target) === 'conversation') base.sessionFile = target.sessionFile
      const filters: UsageFilters = { ...base, range }
      const limit = get().entries[key]?.callsLimit ?? SESSION_CALLS_STEP
      const resetsAt = get().budget?.copilot?.resetsAt
      // The credit-period share ignores the range toggle: it is always this period's spend in the scope.
      const periodFilters: UsageFilters | null = resetsAt ? { ...base, range: 'custom', from: periodStart(resetsAt) } : null
      const [summary, timeseries, tokenMix, byModel, byTool, calls, period] = await Promise.all([
        api.summary(filters, offset),
        // One day is a single bar, so Today reads by hour like the Usage view's hourly chart.
        api.timeseries(filters, range === 'today' ? 'hour' : 'day', offset),
        api.tokenMix(filters, offset),
        api.breakdown(filters, 'model', offset),
        api.breakdown(filters, 'tool', offset),
        api.calls(filters, { key: 'ts', dir: 'desc' }, { index: 0, size: limit }, offset),
        periodFilters ? api.summary(periodFilters, offset) : Promise.resolve(null)
      ])
      if (mine !== sequence) return
      const failure = [summary, timeseries, tokenMix, byModel, byTool, calls].find((r) => !r.ok)
      set((state) => {
        const prev = state.entries[key] ?? EMPTY
        const next: SessionUsageEntry = {
          summary: summary.ok ? summary.value : prev.summary,
          timeseries: timeseries.ok ? timeseries.value : prev.timeseries,
          tokenMix: tokenMix.ok ? tokenMix.value : prev.tokenMix,
          byModel: byModel.ok ? byModel.value : prev.byModel,
          byTool: byTool.ok ? byTool.value : prev.byTool,
          calls: calls.ok ? calls.value.rows : prev.calls,
          callsTotal: calls.ok ? calls.value.total : prev.callsTotal,
          callsLimit: limit,
          periodCredits: period && period.ok ? period.value.credits : null,
          error: failure && !failure.ok ? failure.error.message : null,
          loaded: true
        }
        return { entries: { ...state.entries, [key]: next } }
      })
    },
    showMore(target) {
      const { scope, range } = get()
      const key = entryKey(target, scope, range)
      const prev = get().entries[key] ?? EMPTY
      const callsLimit = Math.min(MAX_CALLS, prev.callsLimit + SESSION_CALLS_STEP)
      set((state) => ({ entries: { ...state.entries, [key]: { ...prev, callsLimit } } }))
      void get().refresh(target)
    },
    setScope(scope) {
      set({ scope })
      persist({ sessionScope: scope })
    },
    setRange(range) {
      set({ range })
      persist({ sessionRange: range })
    }
  }
})
