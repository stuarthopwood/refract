# Research: Session readout

"Verified" means observed in a probe in this repository (scripts in `docs/spike/`, results in
[FINDINGS](../../docs/spike/FINDINGS.md)). "Sourced" means read from documentation, with the
source named. "[INFERENCE]" means neither. Decisions marked **(my default, not confirmed with
Stuart)** follow the brief's instruction to pick the conservative standard option and record it
here rather than block on a question.

## 1. One readout bundle, one coalesced event

**Decision**: main assembles a single `SessionReadout` object per Session (changes, context
usage, turn-time anchor, pull request, subagent counts, todo progress) and pushes it as one
`readout:update` event, coalesced to at most one per 50 ms per Session — the same discipline
`transcript:patch` already uses (spec 001 data-model.md, contracts/ipc.md).

**Rationale**: FR-008 requires every chip to update live; several of its inputs change on
different, sometimes fast, cadences (a ticking turn timer, a streaming context-usage reading). One
coalesced event avoids seven independent IPC channels and matches the one pattern the app already
uses for frequent per-Session updates.

**Alternatives considered**: one event per readout kind (rejected: seven times the event
plumbing for no behavioural gain, and harder to keep atomic — a chip could flash a stale
combination mid-update).

## 2. Reuse spec 001's own readouts, never rebuild them

**Decision**: the Changes chip calls spec 001 task T068's `sessions.diffStat(id)` IPC exactly as
it is contracted (spec 001 `contracts/ipc.md`); it is not redefined or reimplemented here. The
chip row itself is appended after spec 001 task T098's Approval mode pill (the first item in the
row per FR-001); this spec does not build the row or the pill.

**Rationale**: the brief's own instruction ("depend on it, do not duplicate it") and FR-002's
explicit citation of the same figure the Session details card already shows (spec 001 FR-039).

**Consequence for build order**: this spec's Foundational phase assumes spec 001 T068 and T098
have already landed on `main`. If either has not, this spec's chip-row tasks block on them rather
than reimplementing a second copy.

## 3. Pull request lookup: the `gh` CLI directly, no stored token

**Decision (my default, not confirmed with Stuart)**: `src/main/git/github.ts` calls
`gh pr list --head <branch> --json number,url,state --repo <owner>/<repo>` (argument arrays, no
shell, read-only) for the Session's branch, inferring `owner/repo` from the Repository's `origin`
remote URL. No GitHub token is stored; this mirrors the stance spec 003 FR-027 and spec 008
FR-012 already take ("access comes from the developer's own signed-in GitHub CLI").

**Rationale**: spec 003 (the eventual owner of GitHub access) and spec 008 (the eventual owner of
account switching) are both Draft with no plan yet, so there is no shared GitHub-access module to
call into. A direct, minimal `gh` call is the smallest thing that satisfies FR-006 today and is a
straightforward swap for a shared module once spec 003/008 land — it already follows their
same no-token rule, so the swap is a implementation detail, not a behaviour change.

**Alternatives considered**: the GitHub REST API via `fetch` with a stored token (rejected: spec
003/008 explicitly rule out storing a token); waiting for spec 003 to exist first (rejected: this
spec's Independent Test for User Story 1 needs the PR chip now, and spec 003 has no scheduled
land date).

## 4. Pull request chip activation: open in the system browser until spec 003 exists

**Decision (my default, not confirmed with Stuart)**: activating the Pull request chip opens
`https://github.com/<owner>/<repo>/pull/<number>` with `shell.openExternal` (constitution V,
"external links open in the system browser") rather than a Pull requests view that does not exist
yet.

**Rationale**: FR-006 says activation "MUST open that pull request in the Pull requests view
(spec 003)"; spec 003 has a spec but no plan or tasks. The system browser is the conservative,
already-constitutional fallback used everywhere else in the app for an external link, and gives
the developer the same information (the pull request itself) without inventing a placeholder
view. Spec 003, once planned, replaces this call with its own view; this spec does not build
spec 003's view.

## 5. Context-window-usage warning threshold: 90%

**Decision (my default, not confirmed with Stuart)**: the Context window usage chip shows a
visible warning (text or icon, never colour alone, per FR-003/SC-005) once usage reaches 90% of
the window.

**Rationale**: matches the existing pattern of a constant, not-measured default elsewhere in this
app (research.md decision 11 of spec 001 sets the 2 GB low-memory threshold the same way). 90% is
a conservative "near the limit" reading for a value the developer otherwise only sees as a
percentage.

## 6. Settings screen: one generic view-switch store, not a Settings-only mechanism

**Decision**: `src/renderer/state/view-store.ts` holds one union, `view: 'chat' | 'pull-requests'
| 'settings' | 'manage-sessions'`, plus `repositoryId: string | null` and
`settingsSection: SettingsSectionId | null`, with four actions: `openChat(repositoryId?)`,
`openPullRequests(repositoryId)`, `openSettings(section?)`, `openManageSessions()`. `App.tsx`
swaps its rendered main area on `view`, the same way it already swaps on `showReadiness`.
`SettingsScreen.tsx` is a left-section-list layout with one section today ("Session readout",
`SettingsSectionId = 'session-readout'`), reading `settingsSection` to focus the named section
and falling back to the first section when it names one that does not exist yet.

**Rationale**: FR-015 requires the screen to take further sections later "without redesigning the
screen", and spec 008 (whose profile-item cog is the long-term entry point, FR-011, and whose
profile menu adds a `'manage-sessions'` view and a Theme-submenu deep link into a future
`'appearance'` section) and spec 003 (whose "Pull requests" left-nav entry needs its own
`'pull-requests'` view, scoped by `repositoryId`) are both Draft and were coordinating on this
during planning. Three specs independently proposed a same-named `view-store.ts` with
incompatible field names (`view` vs `mode`); rather than each landing its own and clobbering the
others, the three planning sessions (this one, `Plan008Profile`, `Plan003PullRequests`) agreed one
unified shape covering all four views, confirmed over IRC during planning.

**Consequence**: this spec's view-store task builds the whole four-way typed shape (so whichever
spec's implementation lands first does not have to redefine fields the others need), but only
implements real behaviour for `'chat'` and `'settings'`: `openPullRequests` and
`openManageSessions` exist as typed stubs that set `view` (and `repositoryId` for the former) with
no further behaviour, ready for spec 003/008 to add their own `App.tsx` render branch and feature
component without touching the store's shape again. The Settings screen task itself still only
builds the section-list shell generic enough for a second section later, matching FR-015, even
though only one section exists in this spec's scope.

## 7. Temporary Settings entry point, owned by this spec until spec 008 lands

**Decision (my default, not confirmed with Stuart)**: until spec 008's profile-item cog exists,
this spec adds one small, plainly-labelled gear control of its own (not styled as a profile item)
that calls `view-store`'s `openSettings()`, solely so this spec's own Independent Test and
quickstart can reach the Settings screen.

**Rationale**: FR-011 already names spec 008's cog as the real entry point, and spec 008 FR-002
says explicitly that it "replaces spec 004 FR-011's left-nav 'Settings' entry" — so the
left-nav entry originally implied by this spec's own clarification ("a Settings screen opened from
the left nav") is already superseded in the spec text itself. Building a full left-nav entry here
would duplicate work spec 008 is about to replace; a minimal, temporary affordance satisfies this
spec's own verification without pre-building spec 008's deliverable.

**Consequence**: the temporary control is not a tracked requirement of this spec (no FR cites it)
and is not removed by any task here; spec 008's own plan is where it gets superseded.

## 8. Turn time: derived from frames already consumed, no new probe needed

**Decision**: `SessionRuntime.turnStartedAt` is set from the existing `agent_start` frame and
cleared on `session_settled` / a stop, both already consumed by `SessionAgent.ts` (spec 001 T016,
T024). The Turn time chip computes elapsed time from this anchor client-side, ticking once a
second while a turn runs.

**Rationale**: no new OMP read is needed; `agent_start`/`session_settled` are already verified
frames this app relies on for its core status machine (spec 001 data-model.md "State
transitions"). This is distinct from spec 001 task T076's turn-total-time line (which also needs
the per-item timing T071 probes for a *history-reopened* turn); this spec's Turn time chip only
needs to show elapsed time for a *live* turn, which the existing `agent_start` anchor already
covers without waiting on T071's result.

## 9. Subagent chip count versus panel states

**Note, not a decision**: FR-007 literally scopes the Subagents *chip*'s count to subagents
"running or finished" (a `failed` subagent is not literally counted at the chip, by the spec's
own wording), while FR-017 scopes the *panel* to all three states (running, finished, failed).
This asymmetry is in the spec text itself (not introduced here); the implementation must keep the
two counts/lists separately computed rather than reusing one count for both surfaces.

## Unknowns that remain, and where they are resolved (constitution IV)

| Unknown | Resolved by |
|---|---|
| Whether and how OMP reports context-window usage (`get_state` field, or a dedicated `get_session_stats` request) | First probe task: `docs/spike/context-usage-probe.mjs` on OMP 18.4.x |
| Whether and how OMP reports task-list ("todo") progress as counts, not just the hidden tool calls (spec 001 FR-052) | Second probe task: `docs/spike/todo-progress-probe.mjs` |
| Per-subagent id, name, status, and live stream content (text/tool calls) beyond FINDINGS C6's proof that `tool_call_update` progress exists on the `task` tool at all, and beyond spec 001 task T071(d)'s scope (which only needs enough for one collapsed chat line per subagent, not a selectable live stream) | Third probe task: extends FINDINGS C6 and spec 001 T071(d)'s result rather than re-running it from scratch; recorded as a new numbered FINDINGS item and in `contracts/omp-usage.md` |

All three probes are the first tasks in `tasks.md`, per constitution IV ("Features MUST NOT be
designed around a FINDINGS open item... until a probe resolves it").
