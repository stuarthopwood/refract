import type { Repository } from '../../shared/model'
import type { GitHubAccount, Result, SessionSummary } from '../../shared/ipc'
import { useAccountsStore } from './accounts'
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
import { useSplitStore } from './split-store'
import { useThemeStore } from './theme-store'
import { DEFAULT_UPDATE_STATE, useUpdateStore } from './update-store'

// Awaits an initial-load request; an error or a rejected invoke falls back to an empty/default
// value instead of a toast on every cold start. `ok` reports whether the real value loaded
// (quality-gate remediation, code-reviewer Medium): a caller that must not act on the fallback
// as if it were a genuine empty result (see `sessions.list` below) checks this instead.
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

// Spec 008 data-model.md / FR-014: a dedicated initial-load path for `accounts.github.list()`,
// since `gh-not-found` is a state the profile item and Manage accounts dialog show (githubStatus
// 'missing-cli'), not a transient failure -- it must never log as an error or fall through to
// the ordinary empty-list-means-signed-out reading `setGithub` would otherwise give it. A
// `gh-failed` result and a thrown invoke (the handler not registered yet) both resolve to their
// own 'error' outcome (quality-gate remediation, code-reviewer Medium, round 2): the former used
// to fall through to `setGithub([])` -- 'signed-out', "nobody is signed in", when the real
// situation is "the CLI could not be read" -- and the latter used to leave `githubStatus` stuck
// at its initial 'loading' forever if no later broadcast ever arrived, with no way for the user
// to retry. Both now drive the same neutral `setGithubError` the profile item's "GitHub
// unavailable"/"Check again" state already renders, via `initStores`' own caller below.
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
    useThemeStore.getState().setTheme(settings.theme)
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
  // Spec 005 (tasks.md T012): a Windows-notification click, or a restored split that dropped to
  // one surviving Session (main's `index.ts` validateSplitAtStartup), both reuse this one
  // existing event; replaceFocused is the ordinary single-target action (same as a row click).
  window.refract.onUiOpenSession(({ sessionId }) => {
    useSplitStore.getState().replaceFocused(sessionId)
  })
  window.refract.onMemoryWarning((warning) => {
    useMemoryStore.getState().setWarning(warning)
  })
  // Spec 006 contracts/ipc.md `updates:state-changed`: every persisted transition, including
  // the ones pushed mid-download ('downloading' then 'downloaded'/'failed') for a live
  // progress indicator in the status bar's update badge.
  window.refract.onUpdatesStateChanged((state) => {
    useUpdateStore.getState().setState(state)
  })

  // `accounts:github-changed` can arrive before the initial `accounts.github.list()` load below
  // resolves (another window switching/signing out/adding an account); once it has, the initial
  // load's own result is stale and must never overwrite it (quality-gate remediation,
  // code-reviewer Medium).
  let githubBroadcastReceived = false
  window.refract.onAccountsGithubChanged((accounts) => {
    githubBroadcastReceived = true
    useAccountsStore.getState().setGithub(accounts)
  })
  window.refract.onAccountsGithubAddProgress((progress) => {
    const current = useAccountsStore.getState().addFlow
    // UI M6 (quality-gate remediation): a progress event for a DIFFERENT flowId than the one
    // currently tracked (once one is known) is a stale/cross-flow event -- ignored outright
    // rather than clobbering the flow actually on screen.
    if (current?.flowId && progress.flowId !== current.flowId) return
    useAccountsStore.getState().setAddFlow(progress)
  })

  // Quality-gate remediation (code-reviewer Medium): applied the instant this resolves instead
  // of after the slowest of the unrelated loads below, and skipped entirely once a broadcast has
  // already landed (above) -- the initial load's own result would otherwise be stale.
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

  // Quality-gate remediation (accessibility-auditor MEDIUM, gate-3 M1): a `gh auth
  // login`/`logout` run in an external terminal while Refract is in the background never
  // broadcasts `accounts:github-changed` (that event only fires for changes `gh` itself made
  // through THIS app's own IPC calls) -- the only other signal that the CLI's answer may have
  // changed is the user coming back to the window at all. Replaces the old refresh-on-menu-open
  // (ProfileItem.tsx, removed: re-reading the list while a non-modal menu is open could unmount
  // its own focused first row and drop focus to `<body>`) with a refresh on window focus and on
  // the tab becoming visible again, throttled to once per 5 s and skipped entirely while a read
  // is already in flight (`githubRefreshing`) or an add-account/sign-in-again flow is waiting on
  // user action (`addFlow?.status === 'waiting'`) -- refreshing out from under a running `gh auth
  // login` would be pointless (the list cannot have changed yet) and risks racing its own
  // completion update.
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

  void (async () => {
    const [sessionsLoad, settingsLoad, repositoriesLoad, updatesLoad] = await Promise.all([
      loadInitial(window.refract.sessions.list(), [] as SessionSummary[], 'sessions.list'),
      loadInitial(window.refract.settings.get(), DEFAULT_SETTINGS, 'settings.get'),
      loadInitial(window.refract.repositories.list(), [] as Repository[], 'repositories.list'),
      loadInitial(window.refract.updates.getState(), DEFAULT_UPDATE_STATE, 'updates.getState')
    ])
    useSessionsStore.getState().setSessions(sessionsLoad.value)
    useSettingsStore.getState().setSettings(settingsLoad.value)
    useRepositoriesStore.getState().setRepositories(repositoriesLoad.value)
    useUpdateStore.getState().setState(updatesLoad.value)
    // Spec 005 FR-014: restores a persisted 2-session split (both ids already validated
    // against the registry by main's `validateSplitAtStartup`); never opens (starts) either
    // agent, per research.md Decision 4. Quality-gate remediation (code-reviewer, Medium): only
    // when `sessions.list` genuinely loaded -- restoring against the `[]` FALLBACK (used only
    // when that call itself failed) would make every restored pane's `ChatPane` see
    // `session === undefined`, triggering the FR-016 "deleted" effect and silently erasing a
    // perfectly valid persisted split from settings.json on a transient list failure. Round 2
    // (code-reviewer, Low): this skip is accepted degradation, not a deferred retry -- on a
    // `sessions.list` failure the split stays un-restored for this run, and `settings.json`'s
    // own on-disk copy survives only until the next action that calls `persist()` (any single-
    // pane targeting action, a divider drag, etc.), which overwrites it with `null`. A failed
    // initial `sessions.list` is already a degraded-start condition the user can see and retry
    // (the Readiness/empty-session-list screen); re-restoring after a later successful
    // `refresh()` would need its own one-shot "haven't restored yet" flag, judged out of
    // proportion for this already-rare case.
    if (sessionsLoad.ok) {
      useSplitStore.getState().restoreFromSettings(settingsLoad.value.split)
    }
  })()
}
