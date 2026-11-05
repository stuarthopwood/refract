// Per-Session usage for the right-pane Session usage panel (spec 070 FR-4). Results are keyed by
// the Session directory so switching panes never shows another Session's figures. Separate from
// `useUsageStore`: the dashboard's filters and results must not move when this panel does.
import { create } from 'zustand'
import type {
  UsageBreakdownRow,
  UsageBudget,
  UsageCallRow,
  UsageFilters,
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

interface SessionUsageState {
  status: UsageStatus | null
  budget: UsageBudget | null
  entries: Record<string, SessionUsageEntry>
  start(): Promise<void>
  stop(): void
  refresh(sessionDir: string): Promise<void>
  showMore(sessionDir: string): void
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

const tz = (): number => new Date().getTimezoneOffset()

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
let watchedDir: string | null = null
let lastProgress: Pick<UsageStatus, 'running' | 'sessionsDone' | 'sessionsSeen'> | null = null
let trailing: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let dirty = false
const REFRESH_THROTTLE_MS = 1500

/** Trailing-throttled refresh: at most one in flight, one more queued when progress arrived meanwhile. */
function scheduleRefresh(refresh: (dir: string) => Promise<void>): void {
  if (inFlight) {
    dirty = true
    return
  }
  if (trailing) return
  trailing = setTimeout(() => {
    trailing = null
    if (!watchedDir) return
    inFlight = true
    void refresh(watchedDir).finally(() => {
      inFlight = false
      if (dirty) {
        dirty = false
        scheduleRefresh(refresh)
      }
    })
  }, REFRESH_THROTTLE_MS)
}

export const useSessionUsageStore = create<SessionUsageState>((set, get) => ({
  status: null,
  budget: null,
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
      if (watchedDir) scheduleRefresh(get().refresh)
    })
    const started = await window.refract.usage.start()
    if (started.ok) set({ status: started.value })
    const budget = await window.refract.usage.budget()
    if (budget.ok) set({ budget: budget.value })
  },
  stop() {
    unsubscribe?.()
    unsubscribe = null
    watchedDir = null
    if (trailing) clearTimeout(trailing)
    trailing = null
    dirty = false
    sequence += 1
  },
  async refresh(sessionDir) {
    watchedDir = sessionDir
    sequence += 1
    const mine = sequence
    const api = window.refract.usage
    const offset = tz()
    const filters: UsageFilters = { range: 'all', sessionDir }
    const limit = get().entries[sessionDir]?.callsLimit ?? SESSION_CALLS_STEP
    const resetsAt = get().budget?.copilot?.resetsAt
    const periodFilters: UsageFilters | null = resetsAt ? { range: 'custom', from: periodStart(resetsAt), sessionDir } : null
    const [summary, timeseries, tokenMix, byModel, byTool, calls, period] = await Promise.all([
      api.summary(filters, offset),
      api.timeseries(filters, 'day', offset),
      api.tokenMix(filters, offset),
      api.breakdown(filters, 'model', offset),
      api.breakdown(filters, 'tool', offset),
      api.calls(filters, { key: 'ts', dir: 'desc' }, { index: 0, size: limit }, offset),
      periodFilters ? api.summary(periodFilters, offset) : Promise.resolve(null)
    ])
    if (mine !== sequence) return
    const failure = [summary, timeseries, tokenMix, byModel, byTool, calls].find((r) => !r.ok)
    set((state) => {
      const prev = state.entries[sessionDir] ?? EMPTY
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
      return { entries: { ...state.entries, [sessionDir]: next } }
    })
  },
  showMore(sessionDir) {
    const prev = get().entries[sessionDir] ?? EMPTY
    const callsLimit = Math.min(MAX_CALLS, prev.callsLimit + SESSION_CALLS_STEP)
    set((state) => ({ entries: { ...state.entries, [sessionDir]: { ...prev, callsLimit } } }))
    void get().refresh(sessionDir)
  }
}))
