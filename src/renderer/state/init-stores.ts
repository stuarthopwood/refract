import type { Repository } from '../../shared/model'
import type { Result, SessionSummary } from '../../shared/ipc'
import { useCommandsStore } from './commands-store'
import { useMemoryStore } from './memory-store'
import { usePendingRequestsStore } from './pending-requests-store'
import { useQueueStore } from './queue-store'
import { useRepositoriesStore } from './repositories-store'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'
import { useSessionsStore } from './sessions-store'
import { useTranscriptStore } from './transcript-store'
import { useReadoutStore } from './readout-store'
import { useSubagentPanelStore } from './subagent-store'

// Awaits an initial-load request; an error or a rejected invoke falls back to an empty/default
// value instead of a toast on every cold start.
async function loadInitial<T>(request: Promise<Result<T>>, fallback: T, label: string): Promise<T> {
  try {
    const result = await request
    if (result.ok) return result.value
    console.error(`[refract] ${label}: ${result.error.code} ${result.error.message}`)
    return fallback
  } catch (error) {
    console.debug(`[refract] ${label}: invoke failed (handler not registered yet)`, error)
    return fallback
  }
}

// Subscribes every store to its `window.refract` event once, and loads initial data
// (`sessions.list`, `settings.get`, `repositories.list`). Call once from main.tsx.
export function initStores(): void {
  window.refract.onSessionStatus((event) => {
    useSessionsStore.getState().applyStatus(event)
  })
  window.refract.onSessionListChanged(() => {
    void useSessionsStore.getState().refresh()
  })
  window.refract.onTranscriptPatch(({ sessionId, ops }) => {
    useTranscriptStore.getState().applyOps(sessionId, ops)
  })
  window.refract.onQueueUpdate(({ sessionId, followUp, steering }) => {
    useQueueStore.getState().apply(sessionId, followUp, steering)
  })
  window.refract.onRequestPending(({ sessionId, request }) => {
    usePendingRequestsStore.getState().add(sessionId, request)
  })
  window.refract.onRequestResolved(({ sessionId, requestId }) => {
    usePendingRequestsStore.getState().resolve(sessionId, requestId)
  })
  window.refract.onCommandsUpdate(({ sessionId, commands }) => {
    useCommandsStore.getState().setForSession(sessionId, commands)
  })
  window.refract.onSettingsChanged((settings) => {
    useSettingsStore.getState().setSettings(settings)
  })
  window.refract.onReadoutUpdate(({ sessionId, readout }) => {
    useReadoutStore.getState().applyReadout(sessionId, readout)
  })
  window.refract.onSubagentsUpdate(({ sessionId, subagents }) => {
    useReadoutStore.getState().applySubagents(sessionId, subagents)
  })
  window.refract.onSubagentPatch(({ sessionId, subagentId, ops }) => {
    useSubagentPanelStore.getState().applyPatch(sessionId, subagentId, ops)
  })
  window.refract.onUiOpenSession(({ sessionId }) => {
    useSessionsStore.getState().setVisibleSessionId(sessionId)
  })
  window.refract.onMemoryWarning((warning) => {
    useMemoryStore.getState().setWarning(warning)
  })

  void (async () => {
    const [sessions, settings, repositories] = await Promise.all([
      loadInitial(window.refract.sessions.list(), [] as SessionSummary[], 'sessions.list'),
      loadInitial(window.refract.settings.get(), DEFAULT_SETTINGS, 'settings.get'),
      loadInitial(window.refract.repositories.list(), [] as Repository[], 'repositories.list')
    ])
    useSessionsStore.getState().setSessions(sessions)
    useSettingsStore.getState().setSettings(settings)
    useRepositoriesStore.getState().setRepositories(repositories)
  })()
}
