# Refract plan

The ordered work queue for Refract. It exists so one question gets a reliable answer: **what is next?**

- Last updated: 2026-10-06 (after the 2026-10-06 backlog session, issues #443 to #494).
- Source of truth for scope is the GitHub issue. This file holds the **order**, **dependencies** and **status**. Do not copy issue text here.
- `main` was at `f01e862` when this was last refreshed.

## How to use this file

Stuart can say:

| Prompt | What the agent does |
|---|---|
| **What's next?** | First check for an open plan PR (`gh pr list -R stuarthopwood/refract --state open --search "head:docs/plan"`) and read that branch's `docs/PLAN.md` instead of `origin/main`'s when it exists, since it is newer. Then read the Queue top to bottom. Report the first row whose status is `next`, or the first `todo` row whose "Needs" are all `done`. List what can run in parallel (different files, see "File collisions") and anything blocked on a Stuart decision. Do not start work. |
| **Implement the next story** | Take that row, then **stop and confirm with Stuart** (working rule 9): name the story, give the approach and open decisions, and wait for his approval before creating a worktree or editing. After approval: read the issue and the bot triage comment (see AGENTS.md trust model). Work in a **fresh worktree cut from `origin/main`**, never in the main checkout. Implement through Spec Kit where the issue needs a spec. Run the quality gate. Commit and push the branch. Update this file (status, PR link) in the same change. Do not merge unless told. |
| **Implement #N** | Same as above for that issue, regardless of queue order, including the confirmation step. |
| **Update the plan** | Re-read the open issues and `origin/main`, then refresh status, order and the spec table. Say what changed. |
| **Why is X after Y?** | Answer from "Needs" and "File collisions". |
| **Create new issues** (any request to file or amend issues) | File them, then apply working rule 8: place each one in the Queue, update the issue index, and commit and push the plan. Report where each landed. |

Status values: `done`, `next` (start here), `todo`, `blocked` (needs a decision or a dependency), `in-flight` (someone is already on it, do not duplicate), `verify` (built, needs a live check and issue cleanup).

## Working rules (from Stuart, 2026-10-06)

1. **Issue-only unless told.** Filing and analysing issues never implies implementing. Implement only on "implement", "implement #N", "implement the next story", or an equivalent instruction.
2. **Decisions go through `ask`**, never buried in prose. Record the answer in the issue and in the Decisions section below.
3. **The first edit of any story is guarded (#387).** After every edit, check `git diff --stat`: only the intended lines may change. Before committing, scan the files you touched for odd-indent lines (the code base is strictly 2-space; an odd leading-space count that is not a JSDoc ` * ` continuation is the damage signature). Any whole-file churn means stop and re-do the write with a raw filesystem write.
4. **Doc edits and all work land on a branch cut from `origin/main`.** Never on `main`, and never in a checkout with unrelated changes.
5. Follow AGENTS.md: literal absolute paths only for deletes, commit and push after every logical change, answer the question first, and put those rules in every delegation brief.
6. After code changes run the quality gate (tests, build, lint, then reviewers). `main` needs typecheck and production build to pass.
7. Specs are the unit for large features. Small bugs and polish go straight to a branch.
8. **New issues update the plan.** Whenever Stuart asks for new issues to be created, or an existing issue's scope is amended, update this file in the same turn, before the final report:
   - Place each issue in the Queue: phase, position, "Needs", files touched, status. Fold duplicates into the issue that already covers them (as #11 into #440).
   - Add it to the issue index and record any decision he made in "Decisions".
   - Note which existing rows it blocks, gates or overlaps, and any new file collision.
   - Commit and push the change on a branch named `docs/plan-<yyyy-mm-dd>`. Start it from the newest **open plan branch** if one exists, otherwise from `origin/main`, so placements from an earlier filing turn are never lost. Then open a **docs-only PR** to `main` (or update the open one). Stuart merges it, or says "merge the plan" and the agent merges it. A story's own PR must never carry plan changes except that story's status row; if that row conflicts, take the newer `PLAN.md` and re-apply the row.
   - This is the **one write permitted in issue-only mode** (rule 1). Report the placement in the final message, one line per issue ("#NNN is row C4, after #463").
9. **Confirm before starting a story.** On "implement the next story", "implement #N" or similar, do not create a worktree or edit anything yet. First state the story, the approach (Spec Kit route, files touched, how it will be verified) and any open decisions, ask for approval with `ask`, and wait. Start only after Stuart approves. A harness nudge or reminder is not approval.

## Queue

### Phase A: unblock daily driving (do first, in order)

Stuart's goal: start using Refract for real work stories. These make that safe.

| # | Issue | Work | Status | Needs | Files touched |
|---|---|---|---|---|---|
| A1 | #447 | Add repository from the session list after first-run | done (PR #486) | none | `SessionList.tsx`, `AddRepositoryDialog.tsx` |
| A2 | #449 (+#70) | Reattach verification: a lower message count must not strand a Session; add recovery actions to the `start-failed` banner | todo | none | `src/main/omp/reattachVerification.ts`, `SessionAgent.ts`, `ChatPane.tsx` |
| A2b | #485 | Bug: switching Sessions opens at the top; land at the end (remount `Transcript` with a key, or scroll to end after the snapshot renders). First slice of #459 | todo | none; after A2 (same file) | `ChatPane.tsx`, `Transcript.tsx` |
| A2c | #489 | Bug: after a crash and resume, a still-running agent has no Subagents pill. Seed `runtime.subagents` from `get_subagents` on attach and resume, and mark orphaned `running` agents as "agent exited". Needs the repro from Stuart (what crashed, was a process left?) | todo | none; after A2 (same files) | `SessionAgent.ts`, `readout.ts`, `ReadoutChips.tsx` |
| A2d | #491 + #497 | Ask question card: render the question as sanitised markdown at normal weight, heading plus body, vertical options, max height, **and (#497) make option labels and descriptions wrap instead of clipping**. Matters daily because rule 9 starts every story with an `ask` card | todo | none; same file as the Ask UI lane (`RequestCard.tsx`: do before #446, #444, #473) | `RequestCard.tsx`, `card.tsx` use |
| A2e | #492 | Bug: Subagents (Agents) panel content does not wrap and has no padding (Radix `ScrollArea` table child, truncating tool rows, `p-2` vs `px-3`). Do it in a way #490 carries over | todo | none; before C2c | `SubagentPanel.tsx`, `ScrollArea` wrapper, `CollapsedLine.tsx` |
| A2f | #500 + #498 | Pull request view fixes: **#500** the repository selector does not open (the header sits in the window drag region: add `no-drag-region`, reserve the caption-button corner), then **#498** the Merge dialog overflows (radio list or wrapping methods, shorter primary button, wider dialog). Same nowrap pattern as #492 and #497 | todo | none | `PullRequestsView.tsx`, `MergeDialog.tsx`, `alert-dialog.tsx` |
| A3 | #387 | Guard: odd-indent scan script plus fix the 4 damaged files on `main`; report the write-path tool upstream | todo | none (human part) | `SessionDetailsCard.tsx`, `sessionDisplay.tsx`, `useWorktreeActions.ts`, `modelDisplay.ts`, new script |
| A4 | #480 | Rename a repository's display name (persisted) | todo | A1 | `SessionList.tsx`, `repositories.ts`, `registry.ts` |
| A5 | #488 | Remove a repository from the session list, blocked while it owns Sessions (spec 001 FR-059, T107 to T109) | done (PR #493, merged 2026-10-06 13:37; it changed the shared destructive `Button` and the focus ring app-wide, so verify live) | A1 | `SessionList.tsx`, `RemoveRepositoryDialog.tsx`, `repositories.ts`, `registry.ts`, `focus.ts`, `Readiness.tsx`, `button.tsx` |
| A6 | #494 | Bug: taskbar shows the Electron atom icon, not the Refract logo. Launch method confirmed (`pnpm build`, then `electron.exe .`, per `README.md`): `isDev` is `!app.isPackaged`, so the dev `AppUserModelId` pin applies. Fix: set the window icon explicitly (`window.setIcon`) and replace the `process.execPath` AppUserModelId with a Refract id; test both together. The packaged fix comes with spec 006 (`electron-builder.yml` `win.icon`, #277), which does not help this launch method | todo | none; coordinate with `spec-006-impl` (same `AppUserModelId` code) | `src/main/index.ts`, `README.md` |

### Phase B: decisions and probes (can run in parallel with A, no code collisions)

| # | Issue | Work | Status | Needs | Notes |
|---|---|---|---|---|---|
| B1 | #474 | **UI design system** grill-with-docs session (icon, button, label rules) | blocked | Stuart's time | Gates every new UI feature (list under "Gated by #474"). `p1`. Doc edits on a fresh branch. |
| B2 | (probe batch) | One read-only probe agent, results appended to `docs/spike/FINDINGS.md` (constitution IV) | todo | none | See "Probe batch" below. Unblocks 6 issues. |
| B3 | #460 | Versioning and changelog policy decision | blocked | Stuart | Needed before the first release (spec 006). |
| B4 | #4 / #458 | Token layering decision (part of the #474 grill, items 9 and 10) | blocked | B1 | |

### Phase C: right panel, FDB panels and side chat (Stuart's highest-priority features)

| # | Issue | Work | Status | Needs |
|---|---|---|---|---|
| C1 | #393 + #394 | Right panel shell: icon rail, tab strip, window-controls corner, **plus the FDB Knowledge and Agent Builder placeholder panes** (`p1`, demo-critical, "will sell the prototype to the bosses"). Head start: stash commit `b12a884` ("side-panel placeholder WIP"); also `9053ad5` ("394 a11y WIP"). Cite them by hash, not `stash@{n}`, because stash indices move | todo | A done (touches `App.tsx`); B1 for icons; Stuart's call on demo content (strict empty states vs a labelled "Sample data" toggle) |
| C2 | #1 | **Side chat (`/btw`)** as the first pane, via the bundled `runEphemeralTurn` extension | todo | C1, B2 (extension probes) |
| C2c | #490 | **Agents panel**: persistent right side bar tab, **always available and closed by default**, all agents grouped by Session (Session status as the group header, subagents as rows), Cancel and Steer actions. Replaces the click-the-pill-only Subagent panel and folds in #10. Builds on A2c's `get_subagents` seed | todo | C1, A2c, A2e, B2 (`get_subagents`, `cancel_subagent`, `steer_subagent` on 18.4.x and 18.5.x) |
| C2d | #507 | **Agents button with a subagent count on each Session row**, opening the Agents panel on that Session. Needs a per-Session `subagents` count on `SessionSummary` and a coalesced `session:list-changed`, which is the first piece of #490's cross-Session tracker (build them together or right after) | todo | C2c (#490 panel and tracker), A2c (#489 seed after resume); serialise on `SessionList.tsx` with A4, #453, #472, #440, #503, #504 |
| C2a | #392 | **FDB Knowledge**: real integration with FDB's AI knowledge base (`p1`). Routes: its MCP for agents, Refract as MCP client, REST API, OMP host tools (`set_host_tools`) | blocked | C1, FDB discovery (does it have an MCP, an API, auth, data governance), B2 host-tool probe |
| C2b | #391 | **Agent Builder**: real integration with FDB's cloud agent factory (agents persistent or automated, each in a VM) (`p1`). Routes: API, MCP, host tools, deep link as fallback | blocked | C1, FDB discovery (API, auth, run and log streaming), #479 unattended policy for approvals |
| C3 | #478 | Jira panel (associated ticket, browse, link, comment, open in Jira) | blocked | C1, **Stuart's integration decision** (A own REST client, B MCP client, C via the agent) |
| C4 | #463 | File explorer with preview and Open in VS Code | todo | C1 |
| C5 | #464 (+#2) | Git changes, stage, commit, AI commit message; fold #2 (commit, push, PR controls) in | todo | C1, C4 (shared status), B2 (`omp commit` probe) |
| C6 | #3 | Terminal, tabs, per-Session shells | todo | C1, B2 (PTY on Electron 44.5.1) |
| C7 | #465 | `@` mentions in the composer | todo | B2 (`@path` over RPC), C4 |
| C8 | #470 | File editing with AI assist and autocomplete | todo | C4, B2 |

### Phase D: parallel lanes (start any lane once A is done; keep one agent per file)

Lanes touch different files, so they can run concurrently in separate worktrees.

| Lane | Order | Status |
|---|---|---|
| **Transcript** | #459 autoscroll, #430 nested tool boxes, #473 and #360 spacing, then #466 / #467 / #468 message actions and #469 tool icons (the last two after B1), then **#502 subagent bubbles with agent-type icons, grouped and indented by batch** (after #430 and #469: it shares #469's icon mapping module and replaces the one-line `SubagentRow`; coordinate with #490 so the same agent looks the same in the panel), and **#505 user GitHub avatar on messages** (small and independent: reuses spec 008's `avatarDataUrl`; do it after A2d because it also edits `RequestCard.tsx`. Reuse the same JS string for every message. Do **not** use a blob URL: the CSP is `img-src 'self' data:` with no `blob:`, so it would be blocked and fall back to initials) | todo |
| **Ask UI** | #446 multi-select loop, #444 options and tab per question (also fixes the multi-question display seen in #473) | todo |
| **Session list** | #440 titles (fold #11 in), #439, then #453 collapse, then #472 conversation list | todo, after A4 (same file) |
| **Settings** | #455 roles (via `omp config`), #457 thinking and tool-call toggles, #475 advisor, #476 auto-cleanup, #454 session model | todo, after B2 |
| **Menus and keys** | #445 + #471 context menus, #6 shortcut set with #395 and #429 | todo |
| **Theme and chrome** | **#482 session status style (colour-coded icons by default, optional dots, preview)** right after A3 (`sessionDisplay.tsx` is one of the damaged files), then #458 + #456 tokens, then #452 (default Dark retune, "somewhere between"), #4 fonts, #448 and #450 | todo; #482 after A3, the rest after B1 and B4 |
| **Composer** | #432 drag and drop images, #431 pasted images to disk, #443 emoji | todo |
| **Readout pills** | **#496 Approval mode pill into the composer box before the model badge, Todo pill first in the pill row** (do this first: it reshapes the row), then #438 (Todo pill opens the task list, now the first pill), #434, #435, #436, #437, then **#441 + #506 the Context pill menu** (click to compact now, plus Shake context, Shake images, Shake thinking, a visible result, and an auto-compaction switch; probe `/shake` semantics first, and check whether shake or compaction lowers `messageCount` and trips #449's reattach check). Coordinate with #454 (model and thinking pickers, same bottom row) and #433 (mode pill) | todo; serialise with the Composer lane (`MessageInput.tsx`); #506 needs the B2 probe |
| **Pull requests (spec 003)** | #499 filter redesign (compact scope control plus State and Relation, no wrapping tabs); after A2f (same view) | todo; after A2f, and settle the control style with the #474 grill if it is running |
| **GitHub issues** | **#503 Report an issue** (repository-header button and dialog, v1 without the AI draft: title, description, labels from the repository, live duplicate check, file with `gh issue create --body-file -`), then **#504 Issues page** (cross-repo list, State, Repository, Relation, Label and text filters, detail pane, and the separate **GitHub tools block** with vertical space in the session list), then #503's AI drafting step (needs a mechanism probe) and "Start a Session from this issue". Share one list shell with the Pull requests page (#499, #500) | todo; both edit `SessionList.tsx`, so after A4 (#480) and serialised with the Session list lane; the gh issue wrappers go in `src/main/github/gh.ts` |

### Phase E: later

#479 goal mode (needs the Ask UI lane and probes), #477 pause mode (needs the `/pause` probe), #433 plan and Grill Me mode, #8 remaining native commands, #442 spike (merge worktrees), #133 spike (GitHub OAuth), #10 subagent progress view (check if stale), #361, #362 cleanup, #16 / #17 / #18, dependabot PRs #95 and #96.

## Spec tracks

Checked on `origin/main` by searching for each spec's symbols, plus open branches. Not a task-by-task audit.

| Spec | State | Next step |
|---|---|---|
| 006 Installer and updates (#117) | **in-flight**: branch `spec-006-impl` (22 commits ahead of `main` when last checked 2026-10-06), worktree `C:/Repos/personal/pinion-spec-006`, no PR yet | Another session is on it. Do not duplicate. Next: gate fixes, then open the PR. Needs #460 for the release workflow. It also edits the `AppUserModelId` code that A6 needs. |
| 008 Profile and accounts (#132) | merged (PR #451, `accounts.ts` and GitHub CLI present) | `verify`: live check, close stale task issues |
| 003 PR management (#101) | merged (PR #389; `PullRequestsView`, `pullRequests.ts`) | `verify`: live check, close the 8 open task issues |
| 011 Brand spinner (#397) | built (`BrandSpinner.tsx`, CSS, `sessionDisplay.tsx`) | `verify`: close the 10 open task issues |
| 012 Brand watermark (#406) | built (`watermarkEnabled` in settings, IPC, preload, `App.tsx`) | `verify`: close the 18 open task issues |

The 003, 008, 011 and 012 cleanup is cheap and can run as one read-and-verify agent per spec. It does not touch product code.

## Gated by #474 (do not build before the icon and button rules exist)

#469 tool icons, #466 / #467 / #468 message actions, #471 context menus, #472 conversation list, #463 / #464 / #465 / #470 panel features, #1 and #3 panes, #478 Jira panel, #457 toggles, and the Theme lane.

Bug fixes and logic-only work are not gated.

Not gated: #482 (it reverses an earlier status-icon decision and only needs A3 first). The FDB placeholders (C1) use only the shell and standard components, so they go ahead with the grill running in parallel, and are restyled if the rules change.

## Probe batch (B2)

One agent, read-only, supported OMP versions 18.4.x and 18.5.x (the machine runs an unverified 18.6.1). Record each result as a FINDINGS row.

1. `set_model` and `set_thinking_level` over RPC, including mid-turn and clamped levels (#454).
2. `omp config get|set|list --json`: can `modelRoles` be set as a record or only per key, do running RPC sessions pick up the change live, and what does `overriddenBy` report (#455, #475, #479).
3. Does a literal `@path` inside a prompt `message` expand over RPC (#465).
4. `runEphemeralTurn`: structured result channel, whether it sees the Session context, multi-turn behaviour, token cap (#1).
5. `/pause`: any route to the process-global gate over RPC or extension (#477).
6. `set_ask_dialog`: the structured `ask` request with `recommended` and `timeout` (#446, #444, #479).
7. `omp commit` headless, and the `commit` role (#464).
8. PTY on Electron 44.5.1: `node-pty` or a ConPTY wrapper through `koffi` (#3).
9. Code autocomplete route for the editor (#470).
10. OMP host tools: `set_host_tools` and `host_tool_call` round trip on 18.4.x and 18.5.x, so Refract can expose FDB Knowledge and Agent Builder to agents without an MCP entry (#392, #391).
11. FDB discovery (needs Stuart and the FDB owners, not an OMP probe): does the knowledge base have an MCP server (tool list), a REST or GraphQL API (OpenAPI), and what auth; the same for the Agent Builder (#392, #391). Also whether the `fdbrp-sme` MCP server is the knowledge base or something else.
12. OMP `/shake` and compaction: what `/shake`, `/shake elide`, `/shake images` and `/shake thinking` print, what each removes and whether it is recoverable, whether the manual command emits `auto_compaction_*` frames and reports freed tokens, and whether shake or compaction lowers `get_state().messageCount` (relevant to #449's reattach verification) (#506, #441, #449).

## Decisions (Stuart, 2026-10-06)

- Explorer and git panels live in the **right-hand panel**, not the left Session list.
- Terminal: **per Refract Session, several tabs each** (each Session has its own set in its worktree).
- Default Dark theme lightening: **somewhere between** x1.15 and +0.15, background about `#1a1a1a` to `#1e1e1e`, chosen by eye. Divider strength reading still open.
- Scroll to top: **top of the conversation**. Scroll to your message: **the prompt this response answers**.
- #474 is top priority. #447 comes first for daily driving. Right-panel build order, **confirmed by Stuart**: shell and FDB placeholders first (C1), then the side chat (C2), then the Agents panel (C2c).
- Conversation titles: derive from the first message now, rename later (#440).
- The two FDB panels are named **FDB Knowledge** and **Agent Builder**. Both are **important and demo-critical** ("what is really going to sell this prototype to my bosses"): #391, #392 and #393 are `p1`. Placeholders (#393) first, real integrations after discovery.
- Session status style (#482): **colour-coded icons by default**, with a Settings option for **dots** and a preview of both.
- Switching Sessions and Conversations lands at the **end** of the conversation by default, and **restores the previous position if the user was reading earlier text** when they left (Stuart, #485 and #459). This partly amends spec 001 line 148 (restore only when detached from the end, not always). "Reading earlier text" means scrolled away from the end when leaving.
- Agents panel (#490): **always available, closed by default** when idle; **each Session's status is the group header, subagents are the rows**.

## Decisions still needed from Stuart

1. #474 design grill session (when).
2. #478 Jira integration route (A, B or C).
3. #460 versioning: pre-1.0 policy and changelog route (manual, Conventional Commits with release-please, or generated from labels).
4. #452 dividers: what "reduce by 50%" means (half the lightness distance, half the alpha, or half the contrast ratio).
5. #454 / #479: unattended policies (see the issues' open questions).
6. #393 demo content: strict empty states only, a clearly labelled "Sample data" toggle, or static concept views.
7. #392 and #391: integration route, once the FDB owners say what exists (MCP, API, host tools).
8. #482: what happens to the brand spinner (a third style, moved elsewhere, or tinted), and the non-colour cue for dots.
9. #489: what exactly he saw after the crash (Refract or omp crashed, was a process left running). Free text, so not in `ask`: he replies when convenient.

## File collisions (one agent per file at a time)

`SessionList.tsx` (A1, A4, #453, #472, #440), `Transcript.tsx` (Transcript lane, Ask UI, #457, #469), `App.tsx` (C1, #453, #393), `SettingsScreen.tsx` (every Settings item, including #482), `sessionDisplay.tsx` (A3, #482), `MessageInput.tsx` (#465, #432, #431, #443, #471), `Markdown.tsx` and `globals.css` (Theme lane, #456), `ChatPane.tsx` (A2, #466 to #468).

Also: `SessionAgent.ts` (A2, A2c, #479, #477), `readout.ts` and `ReadoutChips.tsx` (A2c, #434 to #438), `SessionManager.ts`, `SubagentPanel.tsx` and `readout-store.ts` (C2c, A2c), `ChatPane.tsx` (also A2b).

Also: `MessageInput.tsx` (#496, #454, #465, #432, #431, #443, #471 are all in this file; one agent at a time), `ApprovalModePill.tsx` (#496, #433), `docs/DESIGN.md` lines 24, 25 and 82 (#496, with #139).

Also: `RequestCard.tsx` (A2d, #497, #446, #444, #473). The `whitespace-nowrap` in `Button` bites #492, #497 and #498 alike: decide one shared answer (a `wrap` option on `Button`, or a wrapping option pattern) once, in whichever of them is built first, instead of three one-off fixes. `PullRequestsView.tsx`, `PullRequestList.tsx` and `MergeDialog.tsx` (A2f, #499).

Also: `Transcript.tsx`, `ToolRow.tsx` (`SubagentRow`), `AgentMessageRow.tsx`, `src/shared/model.ts` (`subagent` item) and `src/main/omp/transcript.ts` and `SessionAgent.ts` (`readTaskSpecs`) for #502, alongside the existing Transcript lane items.

Also: `SessionList.tsx` (#503 repository header button, #504 GitHub tools block), `src/main/github/gh.ts` (new issue calls for #503 and #504, shared with spec 003), `view-store.ts` (new `issues` view for #504).

Also: `Transcript.tsx`, `message.tsx`, `RequestCard.tsx` (`AskQuestionRow`) and the accounts store selector for #505, alongside the Transcript lane items.

Also: `src/main/index.ts` (A6, and spec 006's `AppUserModelId` task #277; coordinate with the `spec-006-impl` branch before editing).

Also: `ReadoutChips.tsx` (`ContextUsageChip`), `SessionAgent.ts` (refresh the readout and `lastMessageCount` after a shake or compaction) and `src/shared/slash-commands.ts` (`shake` entry) for #506, with #441 and #437.

Also: `SessionList.tsx` (`SessionRow` trailing controls), `SessionManager.ts`, `src/shared/ipc.ts` (`SessionSummary.subagents`) for #507, with #490.

## Index of issues filed 2026-10-06

#443 emoji, #444 ask options and tabs, #445 spell suggestions, #446 multi-select loop, #447 add repository, #448 border under window controls, #449 reattach, #450 Settings icon, #452 Dark retune, #453 collapsible left pane, #454 session model, #455 role to model, #456 markdown tokens, #457 thinking and tool toggles, #458 tokenise everything, #459 autoscroll, #460 versioning, #463 explorer, #464 git panel, #465 @ mentions, #466 copy, #467 scroll to your message, #468 scroll to top, #469 tool icons, #470 editing, #471 context menus, #472 conversation list, #473 Ask spacing, #474 design system, #475 advisor, #476 auto-cleanup, #477 pause, #478 Jira, #479 goal mode, #480 rename repository, #482 session status style. Amended: #1 side chat, #3 terminal, #4 fonts, #8, #391 Agent Builder (now `p1`), #392 FDB Knowledge (now `p1`), #393 shell and placeholders (now `p1`), #445, #455.

Also filed 2026-10-06: #485 bug, switching Sessions opens at the top (decided: end by default, restore if the user was reading; first slice of #459, which is also amended).

Also filed 2026-10-06: #489 bug (no Subagents pill after a crash and resume), #490 persistent Agents panel (folds #10, which is a duplicate). Folded: #10 into #490.

Also filed 2026-10-06: #491 ask question card readability (minimal formatting), #492 bug, Agents panel content does not wrap and needs padding.

Also filed 2026-10-06: #494 bug, taskbar shows the Electron atom icon instead of the Refract logo (row A6). Status refresh: A1 done (PR #486), A5 #488 done (PR #493, merged); the earlier "removal spec follows" note and "PR open" status were stale.

Also filed 2026-10-06: #496 chat, Approval mode pill moves into the composer box before the model badge and the Todo pill takes its place above (Readout pills lane, first item). DESIGN.md placement text and #139 (T101) need updating with it.

Also filed 2026-10-06: #497 Ask options do not wrap, #498 Merge dialog overflow, #499 PR filter redesign, #500 PR repository selector does not open (drag region). Placed as rows A2d (#497 with #491), A2f (#500 then #498) and the Pull requests lane (#499).

Also filed 2026-10-06: #502 chat, subagents rendered as bubbles with agent-type icons, related agents (same `task` batch) grouped and indented, for example the quality gate reviewers (Transcript lane, after #430 and #469).

Also filed 2026-10-06: #503 Report an issue (repository-header button and dialog, scoped to the repository's issue log) and #504 Issues page (cross-repo browser, filters, GitHub tools block spacing), placed in the new GitHub issues lane, after A4. Amended #502 with verified task-tool facts: `agent` is per item, the batch `context` is required and shared, nested ids are dot-qualified.

Also filed 2026-10-06: #505 chat, user's GitHub avatar on their messages with initials as the fallback (Transcript lane; avatar fetch, cache and CSP handling already exist from spec 008).

Also filed 2026-10-06: #506 context, first-class `/shake` actions on the Context usage pill with a visible result (Readout pills lane, with #441; possible link to the #449 reattach failure). Corrected #505 and its plan row: no blob URLs, the CSP has no `blob:`.

Also filed 2026-10-06: #507 session list, agents button with a subagent count on each Session row that opens the Agents panel (row C2d, with #490). Fixed a misplaced probe item #12 (`/shake` and compaction) that had landed under "Decisions still needed".
