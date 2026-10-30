// Usage view state (spec 060 S2-05): filters and prefs persisted through `usage.setPrefs`, the
// results of every query for the current filters, and the ingest progress. `open()` starts the
// backfill and the progress subscription; `close()` stops the rescan. One fetch per filter change,
// and one per progress event while an ingest runs (the host emits at most one a second).
import { create } from 'zustand'
import type {
  UsageBreakdownRow,
  UsageBudget,
  UsageCallRow,
  UsageCallSortKey,
  UsageFilters,
  UsageFrustration,
  UsageStatus,
  UsageSummary,
  UsageTimeBucket,
  UsageTokenMixRow,
  UsageTopSession
} from '../../shared/ipc-usage'

export const DEFAULT_USAGE_FILTERS: UsageFilters = { range: '7d' }
export const CALLS_PAGE_SIZE = 25

export interface UsageCallsState {
  sort: { key: UsageCallSortKey; dir: 'asc' | 'desc' }
  pageIndex: number
  rows: UsageCallRow[]
  total: number
}

interface UsageState {
  filters: UsageFilters
  jokes: boolean
  prefsLoaded: boolean
  bucket: 'day' | 'hour'
  status: UsageStatus | null
  loaded: boolean
  /** True from a filter, bucket, sort or page change until its results land, so stale figures show a busy state. */
  refreshing: boolean
  error: string | null
  summary: UsageSummary | null
  timeseries: UsageTimeBucket[]
  tokenMix: UsageTokenMixRow[]
  byProject: UsageBreakdownRow[]
  byModel: UsageBreakdownRow[]
  byTool: UsageBreakdownRow[]
  topSessions: UsageTopSession[]
  calls: UsageCallsState
  frustration: UsageFrustration | null
  budget: UsageBudget | null
  /** Every Project, model and reasoning level seen so far, so a chosen filter never empties its own picker. */
  options: { projects: string[]; models: string[]; reasonings: string[] }
  loadPrefs(): Promise<void>
  open(): Promise<void>
  close(): void
  setFilters(patch: Partial<UsageFilters>): void
  setJokes(jokes: boolean): Promise<void>
  setBucket(bucket: 'day' | 'hour'): void
  setCallsSort(sort: UsageCallsState['sort']): void
  setCallsPage(pageIndex: number): void
  refresh(): Promise<void>
}

// `getTimezoneOffset()` is minutes WEST of UTC, the value `ipc-usage.ts` documents.
const tz = (): number => new Date().getTimezoneOffset()

let sequence = 0
let unsubscribe: (() => void) | null = null
let lastRunning = false

function mergeOptions(existing: string[], rows: UsageBreakdownRow[], extra: (string | null | undefined)[]): string[] {
  const set = new Set(existing)
  for (const row of rows) set.add(row.label)
  for (const value of extra) if (value) set.add(value)
  return [...set].sort((a, b) => a.localeCompare(b))
}

export const useUsageStore = create<UsageState>((set, get) => ({
  filters: DEFAULT_USAGE_FILTERS,
  jokes: true,
  prefsLoaded: false,
  bucket: 'day',
  status: null,
  loaded: false,
  refreshing: false,
  error: null,
  summary: null,
  timeseries: [],
  tokenMix: [],
  byProject: [],
  byModel: [],
  byTool: [],
  topSessions: [],
  calls: { sort: { key: 'ts', dir: 'desc' }, pageIndex: 0, rows: [], total: 0 },
  frustration: null,
  budget: null,
  options: { projects: [], models: [], reasonings: [] },
  async loadPrefs() {
    if (get().prefsLoaded) return
    const result = await window.refract.usage.getPrefs()
    if (result.ok) set({ jokes: result.value.jokes, filters: result.value.filters, prefsLoaded: true })
  },
  async open() {
    await get().loadPrefs()
    unsubscribe?.()
    lastRunning = false
    unsubscribe = window.refract.usage.onProgress((status) => {
      set({ status })
      const finished = lastRunning && !status.running
      lastRunning = status.running
      void get().refresh().then(() => {
        if (finished) void window.refract.usage.budget().then((r) => r.ok && set({ budget: r.value }))
      })
    })
    const started = await window.refract.usage.start()
    if (started.ok) {
      set({ status: started.value })
      lastRunning = started.value.running
    } else set({ error: started.error.message })
    await get().refresh()
  },
  close() {
    unsubscribe?.()
    unsubscribe = null
    sequence += 1
    set({ refreshing: false })
    void window.refract.usage.stop()
  },
  setFilters(patch) {
    const filters = { ...get().filters, ...patch }
    set({ filters, refreshing: true, calls: { ...get().calls, pageIndex: 0 } })
    void window.refract.usage.setPrefs({ filters })
    void get().refresh()
  },
  async setJokes(jokes) {
    const previous = get().jokes
    set({ jokes })
    const result = await window.refract.usage.setPrefs({ jokes })
    if (result.ok) set({ jokes: result.value.jokes })
    else set({ jokes: previous })
  },
  setBucket(bucket) {
    set({ bucket, refreshing: true })
    void get().refresh()
  },
  setCallsSort(sort) {
    set({ refreshing: true, calls: { ...get().calls, sort, pageIndex: 0 } })
    void get().refresh()
  },
  setCallsPage(pageIndex) {
    set({ refreshing: true, calls: { ...get().calls, pageIndex } })
    void get().refresh()
  },
  async refresh() {
    sequence += 1
    const mine = sequence
    const { filters, bucket, calls } = get()
    const api = window.refract.usage
    const offset = tz()
    const [summary, timeseries, tokenMix, byProject, byModel, byTool, top, callPage, frustration, budget] = await Promise.all([
      api.summary(filters, offset),
      api.timeseries(filters, bucket, offset),
      api.tokenMix(filters, offset),
      api.breakdown(filters, 'project', offset),
      api.breakdown(filters, 'model', offset),
      api.breakdown(filters, 'tool', offset),
      api.topSessions(filters, offset),
      api.calls(filters, calls.sort, { index: calls.pageIndex, size: CALLS_PAGE_SIZE }, offset),
      api.frustration(filters, offset),
      get().budget ? Promise.resolve(null) : api.budget()
    ])
    if (mine !== sequence) return
    const failure = [summary, timeseries, tokenMix, byProject, byModel, byTool, top, callPage, frustration].find((r) => !r.ok)
    const projects = byProject.ok ? byProject.value : []
    const models = byModel.ok ? byModel.value : []
    set((state) => ({
      loaded: true,
      refreshing: false,
      error: failure && !failure.ok ? failure.error.message : null,
      summary: summary.ok ? summary.value : state.summary,
      timeseries: timeseries.ok ? timeseries.value : state.timeseries,
      tokenMix: tokenMix.ok ? tokenMix.value : state.tokenMix,
      byProject: projects,
      byModel: models,
      byTool: byTool.ok ? byTool.value : state.byTool,
      topSessions: top.ok ? top.value : state.topSessions,
      calls: callPage.ok ? { ...state.calls, rows: callPage.value.rows, total: callPage.value.total } : state.calls,
      frustration: frustration.ok ? frustration.value : state.frustration,
      budget: budget && budget.ok ? budget.value : state.budget,
      options: {
        projects: mergeOptions(state.options.projects, projects, [filters.project]),
        models: mergeOptions(state.options.models, models, [filters.model]),
        reasonings: mergeOptions(
          state.options.reasonings,
          [],
          [...models.map((row) => row.reasoning), filters.reasoning]
        )
      }
    }))
  }
}))
