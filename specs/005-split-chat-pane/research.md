# Research: Split chat pane

Design decisions for generalising Refract's single-visible-session model (spec 001) into a
two-pane split. Format: Decision / Rationale / Alternatives considered. Every OMP, Electron,
GitHub CLI, or Windows behaviour this spec newly relies on is checked against FINDINGS below; none
is found — this spec adds no new OMP, Electron, or Windows surface, only renderer/main
generalisation of code spec 001 already landed.

## Decision 1: One `Split` concept replaces the single `visibleSessionId`

**Decision**: Replace the single `visibleSessionId: string | null` (both
`src/renderer/state/sessions-store.ts` and `src/main/SessionManager.ts`) with a small `Split`
shape: `paneSessionIds: string[]` (length 1 = today's single pane, length 2 = split),
`focusedIndex: 0 | 1`, `dividerPercent: number`. Main only ever needs the *set* of currently-shown
session ids (for transcript-patch forwarding and the unread rule, FR-018); it has no reason to
know which pane is which, so `sessions.setVisible` takes a plain `string[]` (0–2 ids), not a
per-pane call.

**Rationale**: `src/renderer/state/queue-store.ts`, `pending-requests-store.ts`, and
`commands-store.ts` are already keyed `Record<sessionId, ...>` (built that way in spec 001 for the
"survives a Session switch" requirement, FR-030) — they need no change at all for a second pane to
work. Only `transcript-store.ts` (today a single `{ sessionId, items }` pair, because only one
pane could ever be visible) and the two `visibleSessionId` singulars need to become
session-keyed/set-based. This keeps the generalisation small and consistent with how spec 001
already solved the "more than one session has state" problem everywhere else.

**Alternatives considered**: A fully generic N-pane model — rejected, FR-002 caps the split at
exactly two panes by Stuart's own wording ("two sessions"), so an open-ended list only adds
unused flexibility. Keeping `visibleSessionId` and bolting on a parallel
`secondaryVisibleSessionId` — rejected, it does not name a "focused pane" cleanly and keeps
pane/focus logic scattered across two parallel fields instead of the one `Split` entity the spec
itself names (spec.md Key Entities).

## Decision 2: `sessions.setVisible` becomes array-valued; `transcript:patch` is unchanged

**Decision**: Change the contract method `sessions.setVisible(sessionId: string | null): void` to
`sessions.setVisible(sessionIds: string[]): void`. `transcript:patch`'s payload shape
(`{ sessionId, ops }`) is unchanged; the renderer's generalised `transcript-store.ts` keys patches
by the `sessionId` already in every payload, same as `queue-store.ts` does today.

**Rationale**: `SessionManager.setVisible` (src/main/SessionManager.ts) only ever used
`visibleSessionId` for two things: deciding whether to forward a `patch` event
(`getOrCreateAgent`'s `agent.on('patch', ...)` closure) and deciding whose `unread` to clear and
whose transcript to flush on becoming visible. Both generalise directly to "is this id in the
current set" with no behavioural change for the existing single-pane case (a one-element array
behaves exactly like the old single id).

**Alternatives considered**: A per-pane call, `sessions.setVisible(paneIndex, sessionId | null)` —
rejected: main never needs pane identity, only the renderer's split-store does, so threading pane
indices through IPC would add a parameter main ignores.

## Decision 3: the Split persists in `settings.json`, not `registry.json`

**Decision**: Add `split: SplitLayout | null` to `Settings` (`src/shared/model.ts`), written by a
new request `settings.setSplit(layout: SplitLayout | null): Promise<Result<Settings>>`
(`src/main/store/settings.ts`, `src/main/ipc/settings.ts`), broadcast on the existing
`settings:changed` event (no new event needed).

**Rationale**: the spec's own Assumptions say the split is "an app-wide layout, not scoped to one
repository" — either pane can show a session from any Repository, including two from different
Repositories at once. That is exactly the shape `Settings` already holds (`approvalMode`): one
app-wide singleton row, not a per-Repository or per-Session list. `registry.json` holds
Repository/Session *entities*; a one-off layout value does not belong there.

**Alternatives considered**: a fourth JSON file (`layout.json`) — rejected as YAGNI: one more
atomically-written file for one small record when `settings.json` is already exactly this kind of
app-wide-singleton-preference file.

## Decision 4: restoring a split never calls `sessions.open` (FR-014)

**Decision**: On restore, the renderer populates `paneSessionIds` straight from
`settings.get()`'s `split` field (after main has already dropped any session that no longer
exists or is archived — see Decision 3b below) and marks both pane slots "pristine". Each pane's
`ChatPane`-equivalent component skips its own mount effect (today: "ask for a full snapshot
whenever the visible Session changes", `ChatPane.tsx` lines 96-129) for a pristine pane, instead
rendering from the `SessionSummary` that `sessions.list()` already returned — `status: 'stopped'`,
`stopReason: 'not-started'` — exactly the look a Session that was never opened this run already
has elsewhere in the app, with an empty transcript (nothing has been fetched for it) and no
stop-reason banner (`ChatPane.tsx`'s existing `showBanner` already excludes `'not-started'`). A
pane stops being pristine, and behaves exactly like any other pane from then on, the moment any
real action opens that session — most commonly `MessageInput.tsx`'s existing `notStarted` branch,
which already calls `sessions-store.ts`'s `open()` before sending a first message to a
never-started Session — or the developer clicking that row elsewhere, or choosing "Open in
split"/Ctrl+click on it, any of which is a fresh user action and clears pristine for that pane.

**Rationale**: `sessions.open`'s own handler (`src/main/ipc/sessions.ts` `attachSnapshot`,
`canAutoStart`) auto-starts a stopped agent whenever its `stopReason` is `undefined`,
`'not-started'`, or `'worktree-missing'` — which covers every Session that has never been opened
this run. Today's only caller, `ChatPane`'s mount/switch effect, calls it unconditionally on every
`sessionId` change, so there is literally no existing code path that shows a Session's pane
without starting its agent. FR-014 requires exactly that for a restored split, so a new "don't
auto-open yet" branch is unavoidable; reusing `sessions.list()`'s already-returned
`SessionSummary` and the already-existing `notStarted` message-box behaviour keeps the new branch
to "skip one effect call", not a parallel rendering path.

**Decision 3b (validation on restore, FR-015)**: before handing `split` to the renderer, main
drops any session id no longer present in the registry or now archived; if that leaves one
session, `split` becomes a single-pane layout (`paneSessionIds` of length 1) with that session
focused; if it leaves none, `split` becomes `null`. The corrected value is written back to
`settings.json` so a stale id is not re-offered on the next restart. This runs at app start
(`src/main/index.ts`, alongside the existing `reapStale()` call) purely against the registry
already loaded in memory — no agent is started to perform this check.

**Alternatives considered**: a new `sessions.peek(id)` IPC call returning cold-render data —
rejected, `sessions.list()` already returns everything a pristine pane needs (name, branch,
status, stopReason), so a new method would duplicate existing data for no gain. Starting both
agents immediately on restore — rejected outright: FR-014 explicitly forbids it, and spec 001's
Assumptions (a live agent costs 1.1–1.9 GB and ~16 s to cold-start) are exactly why.

## Decision 5: divider drag and keyboard resize use `react-resizable-panels` as-is

**Decision**: Build the split as a nested `ResizablePanelGroup` (horizontal) of two `ChatPane`s
inside the existing chat region (`App.tsx`), using the same `ResizableHandle withHandle` the
session-list/chat divider already uses. No new resize logic is written. `dividerPercent` is read
from and written through the group's `onLayoutChanged(layout, meta)` callback, persisted via
`settings.setSplit` only when `meta.isUserInteraction` is `true` (debounced ~300 ms while
dragging), never for the programmatic layout set when a restored split first mounts.

**Rationale**: verified against the installed library's own documentation (Context7,
`/bvaughn/react-resizable-panels`, matching the `react-resizable-panels@4.14.1` the repo already
has and the `Group`/`Panel`/`Separator` primitives `src/renderer/components/ui/resizable.tsx`
already wraps): the handle (`Separator`) the repo's `ResizableHandle` already renders is natively
keyboard-operable — the library's internal layout math recognises a dedicated `"keyboard"` input
trigger alongside `"mouse-or-touch"` and `"imperative-api"`, and arrow keys resize the adjacent
panels once the handle has focus. `Group`'s `onLayoutChanged(layout, { isUserInteraction })`
callback exists specifically to distinguish a user-driven resize (drag or keyboard) from a
programmatic one (initial mount, restore), which is exactly the distinction Decision 4 needs so
that restoring a split never re-triggers a "the user moved the divider" write. FR-002's "adjust
with the keyboard" and FR-023 therefore need no new keyboard-handling code — only the existing
`tabIndex`/`focus-visible` styling `ResizableHandle` already has, which satisfies "a visible focus
indicator" (FR-023, SC-005) unchanged.

**Alternatives considered**: hand-rolled `pointermove`/`keydown` resize logic — rejected, it
would reinvent behaviour the library already provides correctly and accessibly, for a resizable
layout spec 001 is already using elsewhere in the same app.

This is the one third-party-library behaviour this spec newly relies on; it is not an OMP,
Electron, GitHub CLI, or Windows behaviour (constitution Principle IV's named scope), so it is
recorded here as a sourced Decision rather than as a `docs/spike/FINDINGS.md` probe item.

## Decision 6: minimum pane width and the narrow-window collapse (FR-017) — conservative, unconfirmed with Stuart

**Decision**: each pane's `minSize` is the same floor the single chat region already uses today
(`App.tsx`'s `ResizablePanel id="chat" minSize={360}`), i.e. 360 px per pane. Below
`2 × 360 = 720` px of total chat-area width, the layout shows one pane — the **focused** pane's
session — and the chat header grows a small, always-visible chip naming the other (hidden)
pane's session; clicking the chip swaps which session is focused-and-shown with the hidden one
(an ordinary focus-plus-replace, same code path as FR-008/FR-009), so the second session is never
more than one click away (FR-017, SC-007) regardless of pointer or keyboard use. The instant the
chat area is 720 px or wider again, both panes reappear automatically at the last
`dividerPercent`.

**Rationale**: this is Stuart's own wording, reused rather than invented — the spec's Assumptions
section already states plainly that this reading "is not a separately confirmed answer and should
be confirmed with Stuart" (spec.md Assumptions). Reusing the chat region's own existing minimum
width keeps the two-pane floor consistent with the one-pane floor already shipped, rather than
inventing an unrelated second number.

**Alternatives considered**: picking an arbitrary smaller per-pane minimum (e.g. 280 px, matching
the session-list panel) — rejected, nothing in the spec or existing code ties pane-usability
width to the session list's own width; the chat region's existing floor is the only precedent in
this codebase for "how narrow can a chat pane usefully be". This decision, and the one below, are
exactly the two items `checklists/requirements.md` CHK029 flags as open with Stuart; both are
implemented per this conservative reading and should be revisited once Stuart answers.

## Decision 7: "Open in split" / Ctrl+click while already split, on the one case Stuart was not asked about — conservative, unconfirmed with Stuart

**Decision**: choosing a session already shown in the **focused** pane, by "Open in split" or
Ctrl+click (the case Stuart's "Replace the focused pane" answer did not directly cover — that
answer was about a plain row click), is a no-op: the focused pane keeps showing it (same rule as
FR-009's "already shown in the other pane -> focus instead of duplicating", extended to the
symmetric case). Every other combination follows the spec's requirements exactly as written:
a plain row click always targets the focused pane (FR-008) unless the chosen session is already
in the unfocused pane (FR-009, focuses it instead); "Open in split"/Ctrl+click on a single pane
splits it (FR-001); "Open in split"/Ctrl+click while already split replaces the **unfocused**
pane (FR-012) unless the chosen session is already shown in the focused pane (this Decision).

**Rationale**: disabling the action, or asking the developer which pane to replace, were the
other options spec.md's Assumptions list and reject in favour of "a reading of Stuart's
'Replace the focused pane' answer" — a no-op (rather than a disabled control or a dialog) keeps
every entry point to a split behaving the same way whenever the target is already visible
somewhere: never duplicate, never prompt, just land focus/attention on the pane that already has
it.

**Alternatives considered**: disabling "Open in split" for a session already shown anywhere —
rejected, it would make the menu item's enabled state depend on split state in a way nothing else
in the row menu does today, for a case spec.md explicitly leaves as a reading rather than a rule.

## Decision 8: focus-move keyboard chord (FR-007) — conservative pick per backlog issue #6

**Decision**: **Ctrl+Shift+\\** (backslash, evoking the vertical divider) moves focus to the other
pane when a split is open; a small icon-button sits on the divider handle itself (next to the
existing drag grip) as the "visible, focusable control" FR-007 also requires, doing the same
thing on click/Enter.

**Rationale**: FR-007 explicitly defers the exact chord to "the rest of the keyboard shortcut set
(backlog issue #6)"; `docs/DESIGN.md`'s Keyboard table already reserves Ctrl+N, Ctrl+Shift+N,
Ctrl+1–9, Ctrl+B, Ctrl+,, Ctrl+Shift+A, Ctrl+Shift+X, and Ctrl+K — `\` is free, and Windows does
not reserve it (unlike Ctrl+Esc/Ctrl+Shift+Esc, already rejected in that table for the same
reason). This is a placeholder per FR-007's own wording, to be revisited whole when issue #6 is
resolved, not a final answer.

**Alternatives considered**: Tab/Shift+Tab — rejected, that would hijack ordinary field-to-field
tabbing inside a pane (the message box, approval buttons) instead of moving between panes, which
is not what FR-007 asks for.

## Decision 9: pane accessibility construction (FR-005, FR-022, FR-023)

**Decision**: each pane is `<div role="region" aria-label="<Session name> chat">`, with
`aria-current="true"`-equivalent treatment reused from `SessionRow`'s existing pattern: a visible
left-edge accent bar plus a small text "Focused" badge (never colour alone) on the focused pane,
and one shared `aria-live="polite"` text node (outside both panes, in the chat region's own
wrapper) announcing "Focused: <Session name>" whenever `focusedIndex` changes, so a screen reader
hears exactly one short announcement per focus change instead of the whole region re-reading.

**Rationale**: mirrors `SessionList.tsx`'s own existing `aria-current`/non-colour-marker pattern
(`docs/DESIGN.md` "Confirmed in implementation": "each Session state... pairs a distinct icon and
colour with an `sr-only` text label") rather than inventing a new accessibility idiom for this one
feature.

**Alternatives considered**: relying on `aria-selected` inside a `tablist` pattern — rejected, the
two panes are not tabs (both are visible and interactive simultaneously, per FR-004); `region`
with a live-region announcement better matches "two independent, always-visible documents, one of
which currently has input focus".

## Decision 10: the shared Subagents panel (spec 004) is bound by explicit activation, not focus (convergence, 2026-10-04)

**Decision**: spec 004's Subagents panel stays the one shared, single right-side panel it
already is -- this spec does not duplicate it per pane. It is bound to whichever pane's Subagents
chip was last clicked (`useSubagentPanelStore.openPanel(sessionId)`, unchanged signature); moving
focus between panes (the focus-move chord, FR-007/FR-008/FR-009's row-click and Ctrl+click
targeting) never retargets an already-open panel on its own. `src/renderer/App.tsx`'s `onResize`
drag-collapse fallback (dragging the panel open directly, not via a chip, data-model.md/spec 004
Decision already covers the chip path) falls back to opening for the **focused** pane's session,
the same default-target rule FR-008 already uses for an ambiguous row click.

**Rationale**: spec 005's own tasks.md and spec.md Assumptions were written 2026-10-02, before
spec 004 landed; spec 004 already established "the panel only ever changes what it shows on an
explicit user action" (its own quality-gate remediation: a new turn starting, a vanished Session,
or an explicit Close all close or retarget it, nothing else does). Extending that same rule to
"which pane" keeps the single panel predictable across a split instead of silently following
focus and yanking a developer's attention off a stream they were reading in the unfocused pane.
A per-pane panel (two Subagents panels, one per pane) was rejected as unnecessary duplication of
spec 004's existing single right-side region for a case the spec's own layout (session list,
chat, one right region) was never designed to show twice at once.

**Alternatives considered**: always bind the panel to the focused pane, re-pointing it silently
on every focus-move -- rejected, it would close or swap the developer's open subagent stream out
from under them the instant they used the focus-move command for an unrelated reason (reading the
other pane's transcript), the same kind of silent-retarget bug spec 004's own remediation rounds
already fixed once for a different trigger (a new turn, a vanished Session).
