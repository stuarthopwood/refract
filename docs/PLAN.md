# Refract plan

The ordered work queue for Refract. It exists so one question gets a reliable answer: **what is next?**

- Last updated: 2026-10-06 (after the 2026-10-06 backlog session, issues #443 to #480).
- Source of truth for scope is the GitHub issue. This file holds the **order**, **dependencies** and **status**. Do not copy issue text here.
- `main` was at `4b76d3f` when this was written.

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
| A1 | #447 | Add repository from the session list after first-run | done (PR #486; removal spec follows on `spec/remove-repository`, T107 to T109) | none | `SessionList.tsx`, `AddRepositoryDialog.tsx` |
| A2 | #449 (+#70) | Reattach verification: a lower message count must not strand a Session; add recovery actions to the `start-failed` banner | todo | none | `src/main/omp/reattachVerification.ts`, `SessionAgent.ts`, `ChatPane.tsx` |
| A3 | #387 | Guard: odd-indent scan script plus fix the 4 damaged files on `main`; report the write-path tool upstream | todo | none (human part) | `SessionDetailsCard.tsx`, `sessionDisplay.tsx`, `useWorktreeActions.ts`, `modelDisplay.ts`, new script |
| A4 | #480 | Rename a repository's display name (persisted) | todo | A1 | `SessionList.tsx`, `repositories.ts`, `registry.ts` |
| A5 | #488 | Remove a repository from the session list, blocked while it owns Sessions (spec 001 FR-059, T107 to T109) | verify (PR #493 open, not merged; it changes the shared destructive Button and focus ring app-wide, Stuart to approve) | A1 | `SessionList.tsx`, `RemoveRepositoryDialog.tsx`, `repositories.ts`, `registry.ts`, `focus.ts`, `Readiness.tsx`, `button.tsx` |

### Phase B: decisions and probes (can run in parallel with A, no code collisions)

| # | Issue | Work | Status | Needs | Notes |
|---|---|---|---|---|---|
| B1 | #474 | **UI design system** grill-with-docs session (icon, button, label rules) | blocked | Stuart's time | Gates every new UI feature (list under "Gated by #474"). `p1`. Doc edits on a fresh branch. |
| B2 | (probe batch) | One read-only probe agent, results appended to `docs/spike/FINDINGS.md` (constitution IV) | todo | none | See "Probe batch" below. Unblocks 6 issues. |
| B3 | #460 | Versioning and changelog policy decision | blocked | Stuart | Needed before the first release (spec 006). |
| B4 | #4 / #458 | Token layering decision (part of the #474 grill, items 9 and 10) | blocked | B1 | |

### Phase C: right panel and side chat (Stuart's highest-priority feature)

| # | Issue | Work | Status | Needs |
|---|---|---|---|---|
| C1 | #393 + #394 | Right panel shell: icon rail, tab strip, window-controls corner | todo | A done (touches `App.tsx`); B1 for icons |
| C2 | #1 | **Side chat (`/btw`)** as the first pane, via the bundled `runEphemeralTurn` extension | todo | C1, B2 (extension probes) |
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
| **Transcript** | #459 autoscroll, #430 nested tool boxes, #473 and #360 spacing, then #466 / #467 / #468 message actions and #469 tool icons (the last two after B1) | todo |
| **Ask UI** | #446 multi-select loop, #444 options and tab per question (also fixes the multi-question display seen in #473) | todo |
| **Session list** | #440 titles (fold #11 in), #439, then #453 collapse, then #472 conversation list | todo, after A4 (same file) |
| **Settings** | #455 roles (via `omp config`), #457 thinking and tool-call toggles, #475 advisor, #476 auto-cleanup, #454 session model | todo, after B2 |
| **Menus and keys** | #445 + #471 context menus, #6 shortcut set with #395 and #429 | todo |
| **Theme and chrome** | #458 + #456 tokens, then #452 (default Dark retune, "somewhere between"), #4 fonts, #448 and #450 | todo, after B1 and B4 |
| **Composer** | #432 drag and drop images, #431 pasted images to disk, #443 emoji | todo |
| **Readout pills** | #434, #435, #436, #437, #438, #441 | todo |

### Phase E: later

#479 goal mode (needs the Ask UI lane and probes), #477 pause mode (needs the `/pause` probe), #433 plan and Grill Me mode, #8 remaining native commands, #442 spike (merge worktrees), #133 spike (GitHub OAuth), #10 subagent progress view (check if stale), #361, #362 cleanup, #16 / #17 / #18, dependabot PRs #95 and #96.

## Spec tracks

Checked on `origin/main` by searching for each spec's symbols, plus open branches. Not a task-by-task audit.

| Spec | State | Next step |
|---|---|---|
| 006 Installer and updates (#117) | **in-flight**: branch `spec-006-impl` (9 commits ahead of `main`, last push 2026-10-06 12:34), worktree `C:/Repos/personal/pinion-spec-006`, no PR yet | Another session is on it. Do not duplicate. Next: gate fixes, then open the PR. Needs #460 for the release workflow. |
| 008 Profile and accounts (#132) | merged (PR #451, `accounts.ts` and GitHub CLI present) | `verify`: live check, close stale task issues |
| 003 PR management (#101) | merged (PR #389; `PullRequestsView`, `pullRequests.ts`) | `verify`: live check, close the 8 open task issues |
| 011 Brand spinner (#397) | built (`BrandSpinner.tsx`, CSS, `sessionDisplay.tsx`) | `verify`: close the 10 open task issues |
| 012 Brand watermark (#406) | built (`watermarkEnabled` in settings, IPC, preload, `App.tsx`) | `verify`: close the 18 open task issues |

The 003, 008, 011 and 012 cleanup is cheap and can run as one read-and-verify agent per spec. It does not touch product code.

## Gated by #474 (do not build before the icon and button rules exist)

#469 tool icons, #466 / #467 / #468 message actions, #471 context menus, #472 conversation list, #463 / #464 / #465 / #470 panel features, #1 and #3 panes, #478 Jira panel, #457 toggles, and the Theme lane.

Bug fixes and logic-only work are not gated.

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

## Decisions (Stuart, 2026-10-06)

- Explorer and git panels live in the **right-hand panel**, not the left Session list.
- Terminal: **per Refract Session, several tabs each** (each Session has its own set in its worktree).
- Default Dark theme lightening: **somewhere between** x1.15 and +0.15, background about `#1a1a1a` to `#1e1e1e`, chosen by eye. Divider strength reading still open.
- Scroll to top: **top of the conversation**. Scroll to your message: **the prompt this response answers**.
- Side chat has priority over the other right-panel panes. #474 is top priority. #447 comes first for daily driving.
- Conversation titles: derive from the first message now, rename later (#440).

## Decisions still needed from Stuart

1. #474 design grill session (when).
2. #478 Jira integration route (A, B or C).
3. #460 versioning: pre-1.0 policy and changelog route (manual, Conventional Commits with release-please, or generated from labels).
4. #452 dividers: what "reduce by 50%" means (half the lightness distance, half the alpha, or half the contrast ratio).
5. #454 / #479: unattended policies (see the issues' open questions).

## File collisions (one agent per file at a time)

`SessionList.tsx` (A1, A4, #453, #472, #440), `Transcript.tsx` (Transcript lane, Ask UI, #457, #469), `App.tsx` (C1, #453, #393), `SettingsScreen.tsx` (every Settings item), `MessageInput.tsx` (#465, #432, #431, #443, #471), `Markdown.tsx` and `globals.css` (Theme lane, #456), `ChatPane.tsx` (A2, #466 to #468).

## Index of issues filed 2026-10-06

#443 emoji, #444 ask options and tabs, #445 spell suggestions, #446 multi-select loop, #447 add repository, #448 border under window controls, #449 reattach, #450 Settings icon, #452 Dark retune, #453 collapsible left pane, #454 session model, #455 role to model, #456 markdown tokens, #457 thinking and tool toggles, #458 tokenise everything, #459 autoscroll, #460 versioning, #463 explorer, #464 git panel, #465 @ mentions, #466 copy, #467 scroll to your message, #468 scroll to top, #469 tool icons, #470 editing, #471 context menus, #472 conversation list, #473 Ask spacing, #474 design system, #475 advisor, #476 auto-cleanup, #477 pause, #478 Jira, #479 goal mode, #480 rename repository. Amended: #1 side chat, #3 terminal, #4 fonts, #8, #393, #445, #455.
