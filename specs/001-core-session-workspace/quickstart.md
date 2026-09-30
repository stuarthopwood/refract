# Quickstart: verifying the core session workspace

Pinion is a prototype with no automated tests. Each check below is a manual run of the app. Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in [data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, Git for Windows, Node 24 or newer, `pnpm`.
- `omp` 18.4.4 on `PATH` and signed in (`omp --version` prints `omp/18.4.4`).
- A scratch git repository with at least one commit and a `main` branch:
  `git init scratch && cd scratch && git commit --allow-empty -m init`.
- Budget memory: each live Session uses about 1.1 to 1.9 GB (FINDINGS item 13). Close other heavy `omp` sessions before the multi-session checks.

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: start a session and chat (FR-001 to FR-012)**

1. First launch shows the readiness checklist; **Add repository** is enabled only when git, `omp` 18.4.4, and sign-in all pass.
2. Add the scratch repository. Create a Session with Base branch `main`. Expect: a folder under `<scratch>/../pinion-worktrees/scratch/<name>`, a branch of the same name, and the Session in the list with a generated name.
3. Send "List the files in this repo". Expect: text streams in, tool calls appear as one compact row each, and the Session returns to idle.
4. Send a long request, press **Ctrl+Shift+X**. Expect: the turn ends within 3 s and the next message is accepted with no "already processing" error.
5. While a turn runs, type a second message and press Enter. Expect: a chip under the turn; **Send now** steers the turn; removing the chip before the turn ends sends nothing.
6. Run `/new`. Expect: same Session and worktree, empty transcript; the earlier Conversation is in the history and opens and continues.

**Story 2: approvals and questions (FR-015 to FR-019)**

1. With Approval mode **Ask**, request "create a file hello.txt". Expect: an approval card naming the tool and target; Deny leaves no file; repeat and Approve creates it. Reads (for example listing files) never prompt.
2. Ask the agent to ask you a multiple-choice question. Expect: options render and the answer reaches the agent.
3. Switch to another Session while a request is pending. Expect: the first Session shows **needs you** and the request is still there when you return.

**Story 3: Approval mode (FR-015, FR-020, SC-009)**

1. Start a long turn in Ask, then switch the status bar to **Auto**. Expect: the header shows a pending chip and the turn is not interrupted.
2. When the Session goes idle it restarts by itself and reattaches: the transcript is unchanged, and the next write tool call is no longer prompted.

**Story 4: restart the app (FR-022 to FR-024, SC-003, SC-006)**

1. Have a two-message conversation, then kill Pinion from Task Manager (End task on the Pinion process).
2. Expect: within 10 s no `omp.exe` started by Pinion remains (Job Object; check with `Get-Process omp`, ignoring your other sessions by parent pid).
3. Relaunch. Expect: the Session is listed and no agent is running. Open it: both messages are shown, and a follow-up that depends on them is answered correctly.
4. Delete the Session's conversation file on disk, reopen the Session. Expect: a clear "conversation missing" message, not a blank chat.

**Story 5: several sessions (FR-005, FR-006, FR-026, FR-027, SC-005)**

1. Start a long turn in Session A, switch to Session B and send a different request. Expect: both show working; each conversation stays separate.
2. Focus another app. Expect: a Windows notification when a Session needs you or finishes, and none for anything else; clicking it opens that Session.

**Story 6: archive and delete (FR-028, FR-029)**

1. Archive a Session: it leaves the main list and appears under **Archived**; Restore brings it back with its conversations.
2. Make an uncommitted edit in a Session's worktree, then Delete. Expect: a confirmation that names the uncommitted change; nothing is removed until you confirm.
3. Delete a Session's worktree folder by hand. Expect: the Session shows stopped with the missing path and offers Recreate (branch exists), Archive, or Delete; its conversations stay readable (FR-035).

**Story 7: commands and recovery (FR-032 to FR-036)**

1. Type `/`. Expect: the agent's commands are listed and one runs. Send `/notacommand`: a warning and nothing is sent.
2. Kill a Session's `omp.exe` by pid from Task Manager. Expect: the Session shows stopped; **Recover** reattaches and the history is intact.

**Memory (FR-037, FR-038, SC-010)**

1. Open Sessions until free memory drops below the threshold in `src/main/memory.ts`. Expect: a warning within 10 s naming the number of live agents; **Stop agent** on an idle Session frees its memory and the Session stays listed and reopens with its conversation.

## First-task gates

These OMP or platform facts are unverified and are checked before the work that depends on them:

- `koffi` loads in Electron's main process and the Job Object kills a spawned child when Pinion is force-killed.
- electron-vite's preload output runs with `sandbox: true`.
- The `result.details` of a real `edit` tool call, to choose the diff source.
- The signal for "OMP is signed in".
