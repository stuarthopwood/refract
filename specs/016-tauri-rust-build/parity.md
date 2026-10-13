# Parity: `IPC_REQUESTS` / `IPC_EVENTS` / theme bootstrap vs. the Rust build

Every row in this table corresponds 1:1 to an entry in `src/shared/ipc.ts`'s `IPC_REQUESTS` (86
entries), `IPC_EVENTS` (20 entries), or the one synchronous `THEME_BOOTSTRAP_CHANNEL` (1 entry) --
**107 rows total**, read directly from that file (not copied from issue://780's own stale count of
84 requests, see spec.md Assumptions). "Electron source file" is the file under `src/main` that
registers the matching `ipcMain.handle`/`ipcMain.on` or calls the matching
`window.webContents.send`. "Milestone" is `1` for the 23 requests + 8 events + the bootstrap that
FR-012/FR-013 require for User Stories 1-5; everything else is `later`. "Rust status" is `todo` for
every row: no channel has been implemented in `src-tauri/` yet (the scaffold work in progress
alongside this document wires up the dispatch table and the `settings.get`/theme-bootstrap sample
handlers, but does not change this column until that work lands and this file is updated to match,
per tasks.md Phase 4).

## Requests (86)

| Channel | Kind | Electron source file | Milestone | Rust status |
|---|---|---|---|---|
| `readiness.check` | request | `src/main/ipc/readiness.ts` | 1 | todo |
| `repositories.list` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `repositories.add` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `repositories.remove` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `repositories.rename` | request | `src/main/ipc/repositories.ts` | later | todo |
| `repositories.branches` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `repositories.remotes` | request | `src/main/ipc/repositories.ts` | later | todo |
| `repositories.pickFolder` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `repositories.userName` | request | `src/main/ipc/repositories.ts` | 1 | todo |
| `sessions.list` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.create` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.rename` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.open` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.archive` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.restore` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.deleteCheck` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.delete` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.recreateWorktree` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.recover` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.resume` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.stopAgent` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.keepWaitingForStart` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.cancelStart` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.setVisible` | request | `src/main/ipc/sessions.ts` | 1 | todo |
| `sessions.diffStat` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.revealWorktree` | request | `src/main/ipc/sessions.ts` | later | todo |
| `sessions.revealFile` | request | `src/main/ipc/files.ts` | later | todo |
| `attachments.readImageFile` | request | `src/main/ipc/attachments.ts` | later | todo |
| `clipboard.writeText` | request | `src/main/ipc/clipboard.ts` | 1 | todo |
| `conversations.list` | request | `src/main/ipc/conversations.ts` | 1 | todo |
| `conversations.startNew` | request | `src/main/ipc/conversations.ts` | 1 | todo |
| `conversations.open` | request | `src/main/ipc/conversations.ts` | 1 | todo |
| `chat.send` | request | `src/main/ipc/chat.ts` | 1 | todo |
| `chat.stop` | request | `src/main/ipc/chat.ts` | 1 | todo |
| `chat.removeQueued` | request | `src/main/ipc/chat.ts` | later | todo |
| `chat.sendNow` | request | `src/main/ipc/chat.ts` | later | todo |
| `chat.answer` | request | `src/main/ipc/chat.ts` | 1 | todo |
| `chat.commands` | request | `src/main/ipc/chat.ts` | 1 | todo |
| `chat.predictWord` | request | `src/main/ipc/chat.ts` | later | todo |
| `chat.predictWordFeedback` | request | `src/main/ipc/chat.ts` | later | todo |
| `chat.setVisibleSubagent` | request | `src/main/ipc/chat.ts` | later | todo |
| `chat.subagentSnapshot` | request | `src/main/ipc/chat.ts` | later | todo |
| `sideChat.ask` | request | `src/main/ipc/side-chat.ts` | later | todo |
| `sideChat.cancel` | request | `src/main/ipc/side-chat.ts` | later | todo |
| `sideChat.getHistory` | request | `src/main/ipc/side-chat.ts` | later | todo |
| `fileExplorer.listDirectory` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.readPreview` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.getStatus` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.openInVSCode` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.reveal` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.copyPath` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.stopWatching` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `fileExplorer.ensureWatching` | request | `src/main/ipc/fileExplorer.ts` | later | todo |
| `settings.get` | request | `src/main/ipc/settings.ts` | 1 | todo |
| `settings.setApprovalMode` | request | `src/main/ipc/settings.ts` | 1 | todo |
| `settings.setReadoutVisibility` | request | `src/main/ipc/settings.ts` | later | todo |
| `settings.setSplit` | request | `src/main/ipc/settings.ts` | later | todo |
| `settings.setWatermarkEnabled` | request | `src/main/ipc/settings.ts` | later | todo |
| `settings.setTranscriptDisplay` | request | `src/main/ipc/settings.ts` | later | todo |
| `settings.setShowSampleData` | request | `src/main/ipc/settings.ts` | later | todo |
| `settings.setDetectImagePathsOnPaste` | request | `src/main/ipc/settings.ts` | later | todo |
| `modelRoles.list` | request | `src/main/ipc/modelRoles.ts` | later | todo |
| `modelRoles.set` | request | `src/main/ipc/modelRoles.ts` | later | todo |
| `modelRoles.listCatalog` | request | `src/main/ipc/modelRoles.ts` | later | todo |
| `window.popupMenu` | request | `src/main/ipc/window.ts` | later | todo |
| `pullRequests.list` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.detail` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.comment` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.replyToThread` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.resolveThread` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.unresolveThread` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.submitReview` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.merge` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `pullRequests.newSessionFromPullRequest` | request | `src/main/ipc/pullRequests.ts` | later | todo |
| `theme.preview` | request | `src/main/ipc/theme.ts` | later | todo |
| `theme.set` | request | `src/main/ipc/theme.ts` | later | todo |
| `accounts.github.list` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.github.addStart` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.github.addCancel` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.github.switch` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.github.signOut` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.omp.list` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.omp.signIn` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.omp.signOut` | request | `src/main/ipc/accounts.ts` | later | todo |
| `accounts.omp.answer` | request | `src/main/ipc/accounts.ts` | later | todo |
| `app.openReleaseNotes` | request | `src/main/ipc/accounts.ts` | later | todo |

## Events (20)

| Channel | Kind | Electron source file | Milestone | Rust status |
|---|---|---|---|---|
| `session:status` | event | `src/main/ipc/register.ts` | 1 | todo |
| `session:list-changed` | event | `src/main/ipc/register.ts` | 1 | todo |
| `transcript:patch` | event | `src/main/ipc/register.ts` | 1 | todo |
| `queue:update` | event | `src/main/ipc/register.ts` | 1 | todo |
| `request:pending` | event | `src/main/ipc/register.ts` | 1 | todo |
| `request:resolved` | event | `src/main/ipc/register.ts` | 1 | todo |
| `commands:update` | event | `src/main/ipc/register.ts` | 1 | todo |
| `settings:changed` | event | `src/main/ipc/broadcast.ts` | 1 | todo |
| `ui:open-session` | event | `src/main/index.ts` | later | todo |
| `memory:warning` | event | `src/main/memory.ts` | later | todo |
| `readout:update` | event | `src/main/ipc/register.ts` | later | todo |
| `subagents:update` | event | `src/main/ipc/register.ts` | later | todo |
| `subagent:patch` | event | `src/main/ipc/register.ts` | later | todo |
| `side-chat:patch` | event | `src/main/ipc/register.ts` | later | todo |
| `side-chat:interrupted` | event | `src/main/ipc/register.ts` | later | todo |
| `side-chat:conversation-changed` | event | `src/main/ipc/register.ts` | later | todo |
| `file-explorer:patch` | event | `src/main/ipc/fileExplorer.ts` | later | todo |
| `file-explorer:reset` | event | `src/main/ipc/fileExplorer.ts` | later | todo |
| `accounts:github-changed` | event | `src/main/ipc/accounts.ts` | later | todo |
| `accounts:github-add-progress` | event | `src/main/ipc/accounts.ts` | later | todo |

## Bootstrap (1)

| Channel | Kind | Electron source file | Milestone | Rust status |
|---|---|---|---|---|
| `theme:bootstrap` | bootstrap | `src/main/ipc/theme.ts` | 1 | todo |

## Totals

- Requests: 86 total, 23 milestone-1, 63 later.
- Events: 20 total, 8 milestone-1, 12 later.
- Bootstrap: 1 total, milestone-1.
- **Grand total: 107 rows**, 32 milestone-1, 75 later.
