# Quickstart: verifying the core session workspace

Refract is a prototype with no automated tests. Each check below is a manual run of the app. Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in [data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, Git for Windows, Node 24 or newer, `pnpm`.
- `omp` 18.4.x or 18.5.x on `PATH` and signed in (`omp --version` prints `omp/18.4.x` or `omp/18.5.x`).
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

1. First launch shows the readiness checklist; **Add repository** is enabled only when git, `omp` 18.4.x or 18.5.x, and sign-in all pass.
2. Add the scratch repository and click its **+** button. Expect: a folder under `<scratch>/../pinion-worktrees/scratch/<name>` on a new branch of the same name created from the default branch, and the Session in the list under a generated name, selected and open. Double-click **+**: exactly one more Session. Click the branch button, pick another Base branch, and choose **Create session**: the new Session starts from that branch and is selected and open; **Cancel** creates nothing and returns focus to the branch button. Rename the default branch in the scratch repository (`git branch -m main trunk`) and click **+**: a toast says `Base branch not found: main` and no Session is added.
3. Send "List the files in this repo". Expect: text streams in, tool calls appear as one compact row each (consecutive calls to the same tool collapse into one "+ N others" row; a different tool or a Thinking line ends the run), a Thinking line (if any) shows "Thought for Ns" once done, the turn ends with a muted total-time line, and the Session returns to idle. A `todo` call the agent makes along the way never appears as its own row (its state still reads back later), and never splits the surrounding tool calls' own run apart even if it fails; expanding a tool call's Arguments/Output shows a small header naming the language ("json" for arguments, pretty-printed; "bash" for a `bash` call's own command; "diff"/"json"/"text" for output, inferred from its shape).
4. Send a reply-provoking message and ask for a fenced code block, e.g. "reply with a short TypeScript snippet in a ```ts fence". Expect: the fence renders with a small "ts" header and syntax highlighting; a reply with an untagged fence (no language after ```) shows a "text" header with no highlighting and no error.
5. Send a long request, press **Ctrl+Shift+X**. Expect: the turn ends within 3 s and the next message is accepted with no "already processing" error. Send and Stop are round icon-only buttons inside the bottom-right corner of the message box (no "Send"/"Stop" words anywhere); hovering or keyboard-focusing either shows its shortcut as key-cap icons (Send: **Enter**; Stop: **Ctrl**+**Shift**+**X**), never plain text.
6. While a turn runs, type a second message and press Enter. Expect: a chip under the turn; **Send now** steers the turn; removing the chip before the turn ends sends nothing.
7. Run `/new`. Expect: same Session and worktree, empty transcript; the earlier Conversation is in the history and opens and continues.
8. Look at the message box (T063). Expect: a visibly translucent field (a subtle border, not a flat opaque panel) with a muted readout along the bottom showing the Session's provider, model name, and reasoning effort once a turn has run (last known values even after the agent stops or the app restarts), or "Model not known yet" before any turn ever has.
9. Rename the Session (F2 on its row, or the row `⋮` menu). Expect: the new name appears at once in the session list, the chat header, the Base branch picker, the details card, a Delete confirmation, and the next Windows notification; `git branch --list` and the worktree folder name are unchanged; its Conversations still open and continue.
10. Reopen a Conversation whose recorded history carries one blocker, one concern, and one nit `<advisory>` note (OMP appends these outside the normal turn flow, so a live one needs an advisor configured; a recorded history file is the practical way to see all three). Expect: three baseline lines in the error, warning, and muted colours respectively, each with its own icon shape and the severity word ("Blocker"/"Concern"/"Nit", never colour alone), the advisor name and a "T-N" marker when present, and a one-line preview; expanding one shows the full note and its guidance as plain text, never raw `<advisory>` tag text.

**Story 2: approvals and questions (FR-015 to FR-019)**

1. With Approval mode **Ask**, request "create a file hello.txt". Expect: an approval card naming the tool and target; Deny leaves no file; repeat and Approve creates it. Reads (for example listing files) never prompt.
2. Ask the agent to ask you a multiple-choice question. Expect: options render and the answer reaches the agent; once answered, the question collapses to "Asked user:" plus the question cut to one line, expanding to the full question, its options, and (indented below, with your initials and git/Windows account name) "Answer:" the chosen option; a cancelled question shows "Cancelled" instead.
3. Switch to another Session while a request is pending. Expect: the first Session shows **needs you** and the request is still there when you return.

**Story 3: Approval mode (FR-015, FR-020, SC-009)**

1. Start a long turn in Ask, then switch the status bar to **Auto**. Expect: the header shows a pending chip and the turn is not interrupted.
2. When the Session goes idle it restarts by itself and reattaches: the transcript is unchanged, and the next write tool call is no longer prompted.

**Story 4: restart the app (FR-022 to FR-024, SC-003, SC-006)**

1. Have a two-message conversation, then kill Refract from Task Manager (End task on the Refract process).
2. Expect: within 10 s no `omp.exe` started by Refract remains (Job Object; check with `Get-Process omp`, ignoring your other sessions by parent pid).
3. Relaunch. Expect: the Session is listed and no agent is running. Open it: both messages are shown, and a follow-up that depends on them is answered correctly.
4. Delete the Session's conversation file on disk, reopen the Session. Expect: a clear "conversation missing" message, not a blank chat.

**Story 5: several sessions (FR-005, FR-006, FR-026, FR-027, FR-039, FR-044, SC-005)**

1. Start a long turn in Session A, switch to Session B and send a different request. Expect: both show working; each conversation stays separate.
2. Focus another app. Expect: a Windows notification when a Session needs you or finishes, and none for anything else; clicking it opens that Session.
3. Hover a Session row's open button (or give it keyboard focus). Expect: a details card after about 500 ms showing status, relative time, repository, branch and Base branch, the worktree's absolute path, and a files-changed count that matches a direct `git diff --numstat` against the merge-base plus any new untracked files; moving the pointer onto the card keeps it open; Esc dismisses it; it never covers the row. Copy path puts the path on the clipboard; Open in file explorer opens it in Explorer; both are also on the row `⋮` menu.
4. Delete that Session's worktree folder outside Refract, then hover the row again after the app next re-lists Sessions (or restart Refract). Expect: the card marks the path missing and shows "Not available" for files changed instead of a stale count.

**Story 6: archive and delete (FR-028, FR-029)**

1. Archive a Session: it leaves the main list and appears under **Archived**; Restore brings it back with its conversations.
2. Make an uncommitted edit in a Session's worktree, then Delete. Expect: a confirmation that names the uncommitted change; nothing is removed until you confirm.
3. Delete a Session's worktree folder by hand. Expect: the Session shows stopped with the missing path and offers Recreate (branch exists), Archive, or Delete; its conversations stay readable (FR-035).

**Story 7: commands and recovery (FR-032 to FR-036)**

1. Type `/`. Expect: the menu lists only the commands Refract has verified work (the fixed supported set in `src/shared/slash-commands.ts`, built from the probe table in `docs/spike/FINDINGS.md` item 23 and `contracts/omp-usage.md`) -- never OMP's raw, unfiltered list, and never a native command Refract has not built yet. Run each listed command one by one: each shows a visible result (its own output line, the dialog it raises answered through the ordinary request cards, or an error notice) and the Session returns to idle ready for the next message, never stuck. Send `/notacommand` (unknown to OMP) and a hidden command typed by hand (one the probe denylisted, or OMP's own, e.g. `/mcp`): both get the same unknown-command warning and nothing is sent. Adding a newly-probed command to the menu is a code change (rerun the probe, record it, add the name to `SUPPORTED_OMP_COMMANDS`), not a setting.
2. Kill a Session's `omp.exe` by pid from Task Manager. Expect: the Session shows stopped; **Recover** reattaches and the history is intact.

**Memory (FR-037, FR-038, SC-010)**

1. Open Sessions until free memory drops below the threshold in `src/main/memory.ts`. Expect: a warning within 10 s naming the number of live agents; **Stop agent** on an idle Session frees its memory and the Session stays listed and reopens with its conversation.

## First-task gates

These OMP or platform facts are unverified and are checked before the work that depends on them:

- `koffi` loads in Electron's main process and the Job Object kills a spawned child when Refract is force-killed.
- electron-vite's preload output runs with `sandbox: true`.
- The `result.details` of a real `edit` tool call, to choose the diff source.
- The signal for "OMP is signed in".
