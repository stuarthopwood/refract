import type { Repository } from '../../shared/model'
import type { Result, SessionSummary } from '../../shared/ipc'
import type { GitHubAccount } from '../../shared/accounts'
import { useAccountsStore } from './accounts'
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
import { useSessionsStore } from './sessions-store'
import { useTranscriptStore } from './transcript-store'
import { useReadoutStore } from './readout-store'
import { useAdvisorStore } from './advisor-store'
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
import { getDefaultRepositoryId } from '../lib/defaultRepository'

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
    // Gate-fix (round 3, Code3/A11y3 Medium): the Session's agent process just exited -- any
    // `running` side-chat record for it can never settle now (the only process that would have
    // sent its terminal `btw_delta`/`btw_record` is gone), so it must never block Send/Retry/
    // `/btw` forever, even once a fresh process starts for this same Session later.
    if (event.status === 'stopped') {
      useSideChatStore.getState().reconcileInterrupted(event.sessionId)
    }
    // Spec 018 slice 1 (issue #464) FR-015a: the Git changes panel's third refresh trigger --
    // this Session's status transitioning away from `working` -- reusing this exact signal
    // rather than a second Rust-side mechanism (research.md decision 7, `git-changes-store.ts`'s
    // own doc comment has the full reasoning).
    useGitChangesStore.getState().handleStatusTransition(event.sessionId, event.status)
  })
  window.refract.onSessionListChanged(() => {
    void useSessionsStore.getState().refresh()
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
    // #572 gate-fix (round 1, Medium): the one place every ask-dialog resolution path funnels
    // through alike (a user Submit/Cancel, an OMP `cancel` frame, a timeout auto-answer, a turn
    // settle) -- clearing only from AskCard's own Submit/Cancel handlers missed the others. A
    // non-ask requestId simply has no entry to clear (no-op).
    useAskPicksStore.getState().clear(sessionId, requestId)
  })
  window.refract.onCommandsUpdate(({ sessionId, commands }) => {
    useCommandsStore.getState().setForSession(sessionId, commands)
  })
  window.refract.onSettingsChanged((settings) => {
    useSettingsStore.getState().setSettings(settings)
    useThemeStore.getState().setTheme(settings.theme)
    useChatWidthStore.getState().setChatWidth(settings.chatWidth)
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
  window.refract.onSubagentPatch(({ sessionId, subagentId, ops }) => {
    useSubagentPanelStore.getState().applyPatch(sessionId, subagentId, ops)
  })
  // Gate-fix (round 3, Code3/Sec3 HIGH): `recordId` was dropped here, so `applyPatch`'s delta
  // branch (which requires `patch.recordId !== undefined`) silently discarded every real
  // `btw_delta` frame -- round 2's own "match by recordId" fix never did anything in practice
  // because this callsite never forwarded the field the fix depended on.
  window.refract.onSideChatPatch(({ sessionId, delta, recordId, record, notice }) => {
    useSideChatStore.getState().applyPatch(sessionId, { delta, recordId, record, notice })
  })
  // Spec 015 Slice 2 (T013/T014/T017): the file watcher's own per-directory patch, mirroring
  // `onSideChatPatch`'s central-wiring location immediately above.
  window.refract.onFileExplorerPatch(({ sessionId, relativePath, entries, truncated }) => {
    useFileExplorerStore.getState().applyPatch(sessionId, { relativePath, entries, truncated })
  })
  // Gate-fix (round 5, Code5 HIGH1): the watcher-fatal/recreate-worktree/restore/archive
  // lifecycle reset (contracts/ipc.md `FILE_EXPLORER_RESET`) -- drops the Session's stale
  // `bySession` entry so the panel's own root-load effect re-fires instead of showing a stale
  // tree with nothing watching underneath it forever.
  window.refract.onFileExplorerReset(({ sessionId }) => {
    useFileExplorerStore.getState().resetSession(sessionId)
  })
  // Spec 018 slice 1 (issue #464) FR-015b: the Git changes panel's watcher-driven refresh ping
  // (`fs::git_changes_watch_state`, `events::GIT_CHANGES_REFRESH`) -- no payload beyond the
  // Session id, the store always refetches wholesale rather than applying a patch.
  window.refract.onGitChangesRefresh(({ sessionId }) => {
    void useGitChangesStore.getState().load(sessionId)
  })
  // Gate-fix (round 4, Sec4 Medium): covers the approval-mode-restart exit path that never
  // reaches `status: 'stopped'` at all (see `SessionAgentEvents.sideChatInterrupted`'s own doc
  // comment) -- the `onSessionStatus`-triggered reconcile above stays too, as a second,
  // harmless (idempotent) trigger for every OTHER exit path.
  window.refract.onSideChatInterrupted(({ sessionId }) => {
    useSideChatStore.getState().reconcileInterrupted(sessionId)
  })
  // Gate-fix (round 5, Code5 HIGH): OMP's own `btw` topics are scoped to the Conversation (the
  // OMP session file), not the Refract Session -- `clearThread` drops `loaded` so the panel's
  // own effect re-runs `loadHistory` fresh for whichever Conversation is now current, instead
  // of continuing to show the PREVIOUS Conversation's rows (and sending its topic id, which the
  // new Conversation's own side-chat store rejects with "Unknown /btw topic").
  window.refract.onSideChatConversationChanged(({ sessionId }) => {
    useSideChatStore.getState().clearThread(sessionId)
  })
  // Spec 005 (tasks.md T012): a Windows-notification click, or a restored split that dropped to
  // one surviving Session (main's `index.ts` validateSplitAtStartup), both reuse this one
  // existing event; replaceFocused is the ordinary single-target action (same as a row click).
  window.refract.onUiOpenSession(({ sessionId }) => {
    useSplitStore.getState().replaceFocused(sessionId)
  })
  window.refract.onTokenGuardLaunchWarning(showTokenGuardWarning)
  window.refract.onTokenGuardCalls((payload) => useTokenGuardCallsStore.getState().setCalls(payload))
  window.refract.onMemoryWarning((warning) => {
    useMemoryStore.getState().setWarning(warning)
  })
  // Lane R11b (issue #794): drives the status bar's update badge (`StatusBar.tsx`); the initial
  // `updates.getState()` load below covers the window between app start and the first of
  // these, same reasoning as every other broadcast-plus-initial-load pair in this function.
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

  // Issue #569 decisions 2(c)/(d): the sidebar "Pull requests" entry's own trailing active-count
  // (pull-requests-store.ts `refreshActiveCount`) refreshes on the same window focus/visibility
  // signal as `refreshGithubOnFocus` above, but throttled to 60s (a `gh search prs` call plus its
  // per-row check-state lookups is heavier than the plain `accounts.github.list()` read) and
  // scoped to whichever repository `getDefaultRepositoryId()` currently resolves -- never a
  // timer, and skipped entirely while signed out of GitHub or with no repository added yet.
  let lastActiveCountFocusRefresh = 0
  function refreshActiveCountOnFocus(): void {
    if (useAccountsStore.getState().githubStatus !== 'ready') return
    const repositoryId = getDefaultRepositoryId()
    if (!repositoryId) return
    // Gate round 1 fix (Code Medium, decision 2(c)): checked BEFORE stamping the throttle below,
    // so a fetch already in flight (the mount effect, or the account-change refresh) never
    // silently consumes this window's own throttle slot for nothing.
    if (usePullRequestsStore.getState().activeCountFor(repositoryId).loading) return
    const now = Date.now()
    if (now - lastActiveCountFocusRefresh < 60000) return
    lastActiveCountFocusRefresh = now
    void usePullRequestsStore.getState().refreshActiveCount(repositoryId)
  }
  window.addEventListener('focus', refreshActiveCountOnFocus)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshActiveCountOnFocus()
  })

  // Issue #569 decision 2(d): the active GitHub account identity (`login@host`) changing -- a
  // sign-in, sign-out, switch, or a fresh `accounts:github-changed` broadcast -- means every
  // cached active-count is stale (`@me` now means someone else, or nobody), so all of them are
  // dropped rather than picking which ones to keep.
  let lastActiveAccountIdentity: string | null = null
  useAccountsStore.subscribe((state) => {
    const active = state.github.find((account) => account.active)
    const identity = active ? `${active.login}@${active.host}` : null
    if (identity === lastActiveAccountIdentity) return
    lastActiveAccountIdentity = identity
    usePullRequestsStore.getState().clearActiveCounts()
    // Gate round 1 fix (Code/Security/A11y/Arch High): a non-null new identity (a fresh sign-in
    // or an account switch, never a sign-out) immediately re-fetches the default repository's
    // count for THIS account, rather than leaving the sidebar silently blank until the next
    // focus/visibility event or explicit refresh -- `githubStatus` on this same snapshot is
    // already 'ready' by the time `setGithub` (the only caller that changes `active`) commits it.
    if (identity !== null && state.githubStatus === 'ready') {
      const repositoryId = getDefaultRepositoryId()
      if (repositoryId) void usePullRequestsStore.getState().refreshActiveCount(repositoryId)
    }
  })

  // Issue #528, gate round 3 fix (Medium, verification): `repositories.remotes()` isolates the
  // bounded remote-detection step from `repositories.list()` -- `list()` itself is a plain
  // registry read and returns at once, so `App.tsx`'s own `showReadiness = !ready ||
  // !hasRepositories` gate (and therefore the Session list's first paint) never waits on remote
  // detection any more. `remotes()` runs right after and merges in once it resolves (each
  // repository's icon starts as the honest "could not tell" placeholder for that first paint,
  // then updates in place, gate round 4 fix: a repository the shared pool's own deadline cuts
  // off mid-flight is simply absent from that response and keeps whatever it already had, never
  // overwritten with a wrong `unknown`), and again on window focus, mirroring
  // `refreshGithubOnFocus` above (same 5s throttle, skipped while a read is already in flight)
  // -- the one other signal that a developer may have added or changed a remote outside Refract
  // while it sat in the background.
  let lastRemotesFocusRefresh = 0
  let remotesRefreshing = false
  // Gate round 4 fix (Low, verification): `force` bypasses the throttle for the one-shot startup
  // call below -- without it, a `focus`/`visibilitychange` event firing (for example the window
  // regaining focus during its own launch) before `repositories.list()` resolves could consume
  // the throttle window on an empty `repositories` array, leaving the startup call blocked
  // behind the 5s window with every icon stuck on `unknown` until the NEXT focus change.
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
      // Gate round 4 fix (Low, code-reviewer + security-auditor): without this, a rejected
      // `invoke` (the handler missing mid-teardown, or a thrown error) became an unhandled
      // rejection -- the store simply keeps whatever it already had (the `unknown` placeholder,
      // or an earlier confirmed value) either way, so there is nothing more useful to do here
      // than swallow it.
      .catch(() => {})
      .finally(() => {
        remotesRefreshing = false
      })
  }
  window.addEventListener('focus', () => refreshRepositoriesRemotes())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRepositoriesRemotes()
  })

  // Gate round 2 fix (code-reviewer/test-reviewer Medium): `pruneRepositories` below must never
  // run before `restore()` has set the real saved `collapsedRepositoryIds` -- these two blocks
  // used to be fully independent `Promise.all` loads with no ordering between them, so a
  // repositories.list that resolved first pruned against the pre-restore empty default and did
  // nothing, letting a stale id survive until the next successful remove (the D18 departure
  // this once was). `restoredPromise` makes the ordering explicit without coupling the two
  // loads' own timing.
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
    // #735 decision 19: restored in this same Promise.all block, right alongside Settings,
    // not deferred to themeBootstrap -- the Sessions arrive in this same load, so nothing
    // visible is held back by doing it here. Repositories load separately (below) and would
    // otherwise draw open groups that then immediately snap shut once this resolves. Runs
    // against the shared `DEFAULT_SETTINGS` fallback (and still flips `restored` true) even
    // when `settings.get` itself failed.
    useSessionListStore.getState().restore(settingsLoad.value.sessionListCollapse)
    usePullRequestsLayoutStore.getState().restoreFromSettings(settingsLoad.value.pullRequestsListWidthPx)
    restoreRightPane(settingsLoad.value.rightPane)
    startRightPanePersistence()
    resolveRestored()
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

  void (async () => {
    const repositoriesLoad = await loadInitial(window.refract.repositories.list(), [] as Repository[], 'repositories.list')
    useRepositoriesStore.getState().setRepositories(repositoriesLoad.value)
    // Decision 18: pruning only ever runs against a genuinely successful load -- a
    // failed load's own `[]` fallback must never be mistaken for "there are now zero
    // Repositories" and wipe every collapsed id the user had saved. Also waits for
    // `restore()` to have run first (gate round 2 fix above), so it always prunes against the
    // real saved ids, never the pre-restore empty default.
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
