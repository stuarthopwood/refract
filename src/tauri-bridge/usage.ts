import type { Result } from '../shared/ipc'
import { IPC_USAGE_EVENTS, IPC_USAGE_REQUESTS } from '../shared/ipc-usage'
import type { UsageApi, UsageStatus } from '../shared/ipc-usage'

export function usageBridge(
  request: <T>(channel: string, ...args: unknown[]) => Promise<Result<T>>,
  on: <T>(channel: string, handler: (payload: T) => void) => () => void
): UsageApi {
  // An absent time-zone offset is left off the wire so the handler's UTC default applies.
  const tz = (tzOffsetMinutes: number | undefined): unknown[] => (tzOffsetMinutes === undefined ? [] : [tzOffsetMinutes])
  return {
    start: () => request<UsageStatus>(IPC_USAGE_REQUESTS.USAGE_START),
    status: () => request<UsageStatus>(IPC_USAGE_REQUESTS.USAGE_STATUS),
    summary: (filters, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_SUMMARY, filters, ...tz(tzOffsetMinutes)),
    timeseries: (filters, bucket, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_TIMESERIES, filters, bucket, ...tz(tzOffsetMinutes)),
    tokenMix: (filters, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_TOKEN_MIX, filters, ...tz(tzOffsetMinutes)),
    breakdown: (filters, by, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_BREAKDOWN, filters, by, ...tz(tzOffsetMinutes)),
    topSessions: (filters, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_TOP_SESSIONS, filters, ...tz(tzOffsetMinutes)),
    calls: (filters, sort, page, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_CALLS, filters, sort, page, ...tz(tzOffsetMinutes)),
    frustration: (filters, tzOffsetMinutes) =>
      request(IPC_USAGE_REQUESTS.USAGE_FRUSTRATION, filters, ...tz(tzOffsetMinutes)),
    budget: () => request(IPC_USAGE_REQUESTS.USAGE_BUDGET),
    getPrefs: () => request(IPC_USAGE_REQUESTS.USAGE_GET_PREFS),
    setPrefs: (patch) => request(IPC_USAGE_REQUESTS.USAGE_SET_PREFS, patch),
    onProgress: (handler) => on<UsageStatus>(IPC_USAGE_EVENTS.USAGE_PROGRESS, handler)
  }
}
