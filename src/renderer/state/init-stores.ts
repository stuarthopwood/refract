import type { Repository } from '../../shared/model'
import type { Result, SessionSummary } from '../../shared/ipc'
import type { GitHubAccount } from '../../shared/accounts'
import { onGithubChanged } from './github-changed-refresh'
import { useAccountsStore } from './accounts'
import { useAdvisorRosterStore } from './advisor-roster-store'
import { useCommandsStore } from './commands-store'
import { useMemoryStore } from './memory-store'
import { showTokenGuardWarning } from './token-guard-store'
import { useTokenGuardCallsStore } from './token-guard-calls-store'
import { usePendingRequestsStore } from './pending-requests-store'
import { useQueueStore } from './queue-store'
import { useAskPicksStore } from './ask-picks-store'
import { usePullRequestsStore } from './pull-requests-store'
import { useRepositoriesStore } from './repositories-store'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'
import { initHolidayOverrides } from './holiday-store'
import { notifyAlarm } from './notify'
import { useAlarmFiredStore } from './alarm-fired-store'
import { useSessionsStore } from './sessions-store'
import { useTranscriptStore } from './transcript-store'
import { useReadoutStore } from './readout-store'
import { useAdvisorStore } from './advisor-store'
import { usePrewalkStore } from './prewalk-store'
import { useSessionHealthStore } from './session-health-store'
import { useSubagentPanelStore } from './subagent-store'
import { useSideChatStore } from './side-chat-store'
import { useFileExplorerStore } from './file-explorer-store'
import { useGitChangesStore } from './git-changes-store'
import { useSplitStore } from './split-store'
import { usePullRequestsLayoutStore } from './pull-requests-layout-store'
import { restoreRightPane, startRightPanePersistence } from '../features/right-pane/right-pane-persistence'
import { useSessionListStore } from './session-list-store'
import { useThemeStore } from './theme-store'
import { useChatWidthStore } from './chat-width-store'
import { useUpdateStore } from './update-store'
import { useChatAreaAnnouncer } from '../features/chat/chatAreaAnnouncer'
import { showDeleteFailureToast } from '../features/sessions/deleteFailureToast'

// An error or rejected invoke falls back to the default instead of a cold-start toast; `ok` tells callers whether the value is real.
async function loadInitial<T>(request: Promise<Result<T>>, fallback: T, label: string): Promise<{ value: T; ok: boolean }> {
  try {
    const result = await request
    if (result.ok) return { value: result.value, ok: true }
    console.error(`[refract] ${label}: ${result.error.code} ${result.error.message}`)
    return { value: fallback, ok: false }
  } catch (error) {
    console.debug(`[refract] ${label}: invoke failed (handler not registered yet)`, error)
    return { value: fallback, ok: false }
  }
}

// `gh-not-found` is a state the profile UI shows ('missing-cli'), not an error; `gh-failed` and a thrown invoke both
// resolve to 'error' so the UI offers a retry instead of reading as signed-out or staying 'loading'.
async function loadInitialGithubAccounts(): Promise<
  { kind: 'ok'; accounts: GitHubAccount[] } | { kind: 'missing-cli' } | { kind: 'error' }
> {
  try {
    const result = await window.refract.accounts.github.list()
    if (result.ok) return { kind: 'ok', accounts: result.value }
    if (result.error.code === 'gh-not-found') return { kind: 'missing-cli' }
    console.error(`[refract] accounts.github.list: ${result.error.code} ${result.error.message}`)
    return { kind: 'error' }
  } catch (error) {
    console.debug('[refract] accounts.github.list: invoke failed (handler not registered yet)', error)
    return { kind: 'error' }
  }
}

// Subscribes every store to its `window.refract` event once, and loads initial data
// (`sessions.list`, `settings.get`, `repositories.list`). Call once from main.tsx.
export function initStores(): void {
  window.refract.onSessionStatus((event) => {
    useSessionsStore.getState().applyStatus(event)
    // The agent process exited, so a `running` side-chat record can never settle and must not block Send/Retry.
    if (event.status === 'stopped') {
      useSideChatStore.getState().reconcileInterrupted(event.sessionId)
    }
    // Third refresh trigger for the Git changes panel: the Session leaving `working`. (#464)
    useGitChangesStore.getState().handleStatusTransition(event.sessionId, event.status)
  })
  window.refract.onSessionListChanged(() => {
    void useSessionsStore.getState().refresh()
  })
  window.refract.onSessionDeleted(({ sessionId }) => {
    const store = useSessionsStore.getState()
    // Read the name before the refresh drops the Session from the list.
    const name = store.sessions.find((s) => s.id === sessionId)?.name ?? 'Session'
    store.clearDeleting(sessionId)
    void store.refresh()
    useChatAreaAnnouncer.getState().announce(`Deleted ${name}`)
  })
  window.refract.onSessionDeleteFailed(({ sessionId, error }) => {
    const store = useSessionsStore.getState()
    const name = store.sessions.find((s) => s.id === sessionId)?.name ?? 'Session'
    store.clearDeleting(sessionId)
    void store.refresh()
    useChatAreaAnnouncer.getState().announce(`Could not delete ${name}. ${error.message}`)
    showDeleteFailureToast({ id: sessionId, name }, error)
  })
  window.refract.onSessionActivity(({ sessionId, activity }) => {
    useSessionsStore.getState().applyActivity(sessionId, activity)
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
    // Every ask-dialog resolution path (submit, cancel, timeout, settle) funnels through here; a non-ask id is a no-op. (#572)
    useAskPicksStore.getState().clear(sessionId, requestId)
  })
  window.refract.onCommandsUpdate(({ sessionId, commands }) => {
    useCommandsStore.getState().setForSession(sessionId, commands)
  })
  window.refract.onSettingsChanged((settings) => {
    useSettingsStore.getState().setSettings(settings)
    const themeStore = useThemeStore.getState()
    // A freshly imported theme is not in the list yet; load it before the id is looked up.
    if (settings.customTheme && !themeStore.customThemes.some((t) => t.id === settings.customTheme)) {
      void themeStore.refreshCustomThemes().then(() => {
        // A newer settings event may have landed while the list loaded; apply the latest, not this one.
        const latest = useSettingsStore.getState().settings
        useThemeStore.getState().setTheme(latest.theme, latest.customTheme ?? null)
      })
    } else {
      themeStore.setTheme(settings.theme, settings.customTheme ?? null)
    }
    useChatWidthStore.getState().setChatWidth(settings.chatWidth)
  })
  window.refract.onAlarmFired((alarm) => {
    useAlarmFiredStore.getState().markFired(alarm.id, useSettingsStore.getState().settings.alarms ?? [])
    if (document.hasFocus()) notifyAlarm(alarm.label)
  })
  window.refract.onReadoutUpdate(({ sessionId, readout }) => {
    useReadoutStore.getState().applyReadout(sessionId, readout)
  })
  window.refract.onSubagentsUpdate(({ sessionId, subagents }) => {
    useReadoutStore.getState().applySubagents(sessionId, subagents)
  })
  window.refract.onAdvisorUpdate(({ sessionId, advisorOn }) => {
    useAdvisorStore.getState().applyAdvisorOn(sessionId, advisorOn)
  })
  window.refract.onPrewalkUpdate(({ sessionId, state }) => {
    usePrewalkStore.getState().apply(sessionId, state)
  })
  window.refract.onSessionHealth((health) => {
    useSessionHealthStore.getState().apply(health)
  })
  window.refract.onSubagentPatch(({ sessionId, subagentId, ops }) => {
    useSubagentPanelStore.getState().applyPatch(sessionId, subagentId, ops)
  })
  // `recordId` must be forwarded or `applyPatch` discards every `btw_delta`.
  window.refract.onSideChatPatch(({ sessionId, delta, recordId, record, notice }) => {
    useSideChatStore.getState().applyPatch(sessionId, { delta, recordId, record, notice })
  })
  window.refract.onFileExplorerPatch(({ sessionId, relativePath, entries, truncated }) => {
    useFileExplorerStore.getState().applyPatch(sessionId, { relativePath, entries, truncated })
  })
  // Lifecycle reset drops the stale entry so the panel's root-load effect re-fires instead of showing a dead tree.
  window.refract.onFileExplorerReset(({ sessionId }) => {
    useFileExplorerStore.getState().resetSession(sessionId)
  })
  // The watcher ping carries only the Session id; the store refetches wholesale. (#464)
  window.refract.onGitChangesRefresh(({ sessionId }) => {
    void useGitChangesStore.getState().load(sessionId)
  })
  // Covers the approval-mode-restart exit that never reaches 'stopped'; the onSessionStatus reconcile stays as an idempotent second trigger.
  window.refract.onSideChatInterrupted(({ sessionId }) => {
    useSideChatStore.getState().reconcileInterrupted(sessionId)
  })
  // btw topics are scoped to the Conversation, not the Session; `clearThread` makes the panel reload instead of sending a stale topic id.
  window.refract.onSideChatConversationChanged(({ sessionId }) => {
    useSideChatStore.getState().clearThread(sessionId)
  })
  // Notification clicks and a restored split reduced to one Session both reuse this event.
  window.refract.onUiOpenSession(({ sessionId }) => {
    useSplitStore.getState().replaceFocused(sessionId)
  })
  window.refract.onTokenGuardLaunchWarning(showTokenGuardWarning)
  window.refract.onTokenGuardCalls((payload) => useTokenGuardCallsStore.getState().setCalls(payload))
  window.refract.onAdvisorRosterDetected((payload) => useAdvisorRosterStore.getState().setDetected(payload))
  window.refract.onMemoryWarning((warning) => {
    useMemoryStore.getState().setWarning(warning)
  })
  // Drives the status bar's update badge; the initial `updates.getState()` load below covers the gap before the first event. (#794)
  window.refract.onUpdatesStateChanged((state) => {
    useUpdateStore.getState().setState(state)
  })
  // A broadcast can land before the initial list resolves; the initial result is then stale and must not overwrite it.
  let githubBroadcastReceived = false
  window.refract.onAccountsGithubChanged((accounts) => {
    githubBroadcastReceived = true
    useAccountsStore.getState().setGithub(accounts)
  })
  // A merge, close or Session write changed a PR or issue: refresh the loaded lists quietly. (#1589)
  window.refract.onGithubChanged(onGithubChanged)
  window.refract.onAccountsGithubAddProgress((progress) => {
    const current = useAccountsStore.getState().addFlow
    // A progress event for a different flowId is stale; ignore it rather than clobber the flow on screen.
    if (current?.flowId && progress.flowId !== current.flowId) return
    useAccountsStore.getState().setAddFlow(progress)
  })

  void loadInitialGithubAccounts().then((githubAccountsLoad) => {
    if (githubBroadcastReceived) return
    if (githubAccountsLoad.kind === 'missing-cli') {
      useAccountsStore.getState().setGithubMissingCli()
    } else if (githubAccountsLoad.kind === 'error') {
      useAccountsStore.getState().setGithubError()
    } else {
      useAccountsStore.getState().setGithub(githubAccountsLoad.accounts)
    }
  })

  // `gh auth` run in an external terminal never broadcasts, so refresh on focus (throttled 5 s); skip while an add flow waits, since it would race the completion.
  let lastGithubFocusRefresh = 0
  function refreshGithubOnFocus(): void {
    const state = useAccountsStore.getState()
    if (state.githubRefreshing) return
    if (state.addFlow?.status === 'waiting') return
    const now = Date.now()
    if (now - lastGithubFocusRefresh < 5000) return
    lastGithubFocusRefresh = now
    void state.refreshGithub()
  }
  window.addEventListener('focus', refreshGithubOnFocus)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshGithubOnFocus()
  })

  // The sidebar PR active-count refreshes on focus, throttled to 60 s because `gh search prs` is heavy; never a timer. (#569)
  let lastActiveCountFocusRefresh = 0
  function refreshActiveCountOnFocus(): void {
    if (useAccountsStore.getState().githubStatus !== 'ready') return
    const repositoryIds = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
    if (repositoryIds.length === 0) return
    // Checked before stamping the throttle so an in-flight fetch doesn't waste the slot.
    if (usePullRequestsStore.getState().activeCount.loading) return
    const now = Date.now()
    if (now - lastActiveCountFocusRefresh < 60000) return
    lastActiveCountFocusRefresh = now
    void usePullRequestsStore.getState().refreshActiveCount(repositoryIds)
  }
  window.addEventListener('focus', refreshActiveCountOnFocus)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshActiveCountOnFocus()
  })

  // An active-account change makes every cached active-count stale (`@me` changed), so drop them all. (#569)
  let lastActiveAccountIdentity: string | null = null
  useAccountsStore.subscribe((state) => {
    const active = state.github.find((account) => account.active)
    const identity = active ? `${active.login}@${active.host}` : null
    if (identity === lastActiveAccountIdentity) return
    lastActiveAccountIdentity = identity
    usePullRequestsStore.getState().clearActiveCounts()
    // Refetch immediately for the new account so the sidebar isn't blank until the next focus.
    if (identity !== null && state.githubStatus === 'ready') {
      const repositoryIds = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
      if (repositoryIds.length > 0) void usePullRequestsStore.getState().refreshActiveCount(repositoryIds)
    }
  })

  // Remote detection is split from `repositories.list()` so first paint never waits on it; repos cut off mid-flight keep their prior value. (#528)
  let lastRemotesFocusRefresh = 0
  let remotesRefreshing = false
  // `force` bypasses the throttle so an early focus event can't block the startup call.
  function refreshRepositoriesRemotes(force = false): void {
    if (remotesRefreshing) return
    const now = Date.now()
    if (!force && now - lastRemotesFocusRefresh < 5000) return
    lastRemotesFocusRefresh = now
    remotesRefreshing = true
    void window.refract.repositories
      .remotes()
      .then((result) => {
        if (result.ok) useRepositoriesStore.getState().setRemotes(result.value)
      })
      // A rejected invoke leaves the store's prior value in place; swallow it.
      .catch(() => {})
      .finally(() => {
        remotesRefreshing = false
      })
  }
  window.addEventListener('focus', () => refreshRepositoriesRemotes())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRepositoriesRemotes()
  })

  // `pruneRepositories` must not run before `restore()` sets the saved collapsed ids, or a stale id survives.
  let resolveRestored: () => void = () => {}
  const restoredPromise = new Promise<void>((resolve) => {
    resolveRestored = resolve
  })

  void (async () => {
    const [sessionsLoad, settingsLoad] = await Promise.all([
      loadInitial(window.refract.sessions.list(), [] as SessionSummary[], 'sessions.list'),
      loadInitial(window.refract.settings.get(), DEFAULT_SETTINGS, 'settings.get')
    ])
    useSessionsStore.getState().setSessions(sessionsLoad.value)
    useSettingsStore.getState().setSettings(settingsLoad.value)
    useChatWidthStore.getState().setChatWidth(settingsLoad.value.chatWidth)
    // Restored here, not deferred, so groups don't draw open then snap shut; runs on the DEFAULT_SETTINGS fallback too. (#735)
    useSessionListStore.getState().restore(settingsLoad.value.sessionListCollapse)
    // A persisted Show hidden with nothing hidden would draw a toggle with nothing behind it (#1416).
    if (sessionsLoad.ok && !sessionsLoad.value.some((session) => session.hiddenAt)) useSessionListStore.getState().setShowHidden(false)
    usePullRequestsLayoutStore.getState().restoreFromSettings(settingsLoad.value.pullRequestsListWidthPx)
    restoreRightPane(settingsLoad.value.rightPane)
    startRightPanePersistence()
    resolveRestored()
    // Restoring against the `[]` fallback would make panes see a deleted session and erase a valid persisted split.
    if (sessionsLoad.ok) {
      useSplitStore.getState().restoreFromSettings(settingsLoad.value.split)
    }
  })()

  void (async () => {
    const repositoriesLoad = await loadInitial(window.refract.repositories.list(), [] as Repository[], 'repositories.list')
    useRepositoriesStore.getState().setRepositories(repositoriesLoad.value)
    // Prune only on a real load: the `[]` fallback must not wipe the saved collapsed ids.
    if (repositoriesLoad.ok) {
      await restoredPromise
      useSessionListStore.getState().pruneRepositories(new Set(repositoriesLoad.value.map((repository) => repository.id)))
    }
    if (repositoriesLoad.value.length > 0) refreshRepositoriesRemotes(true)
  })()

  void (async () => {
    const result = await window.refract.updates.getState()
    if (result.ok) useUpdateStore.getState().setState(result.value)
  })()

  void (async () => {
    await initHolidayOverrides()
  })()
}
