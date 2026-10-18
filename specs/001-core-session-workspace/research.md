# Research: Core session workspace

Decisions for the implementation plan. "Verified" means observed in a probe in this repository (scripts in `docs/spike/`, results in [FINDINGS](../../docs/spike/FINDINGS.md)). "Sourced" means read from documentation, with the source named. "[INFERENCE]" means neither.

Versions are the npm `latest` (or Electron release table) read on 2026-09-30.

## 1. Toolchain

**Decision**: `electron-vite@5.0.0` scaffolding, Electron `44.5.1` (bundles Node 24.21.0 and Chromium 152), TypeScript `strict`, `pnpm`, React `19.3.0`.

**Rationale**: one config covers main, preload, and renderer, with renderer HMR and main/preload hot reload, which is the shortest `pnpm dev` loop (sourced: electron-vite.org/guide). electron-vite has an isolated build mode meant for `sandbox: true` preloads.

**Alternatives**: `electron-forge` Vite template and `vite-plugin-electron` (more setup for the same result).

**Verified (T003, 2026-09-30)**: electron-vite's default (non-isolated) preload build already runs with `sandbox: true`. A preload exposing one function through `contextBridge.exposeInMainWorld` and calling it from the renderer reported `{ sandboxed: true, contextIsolated: true }` under both `pnpm dev` and a `pnpm build` + `electron .` run, so electron-vite's isolated build mode is not needed.

## 2. Renderer libraries

**Decision**:

| Need | Choice | Version |
|---|---|---|
| State | `zustand` | 5.0.15 |
| Markdown (untrusted) | `react-markdown` + `remark-gfm` + `rehype-sanitize` | 10.1.0, 4.0.1, 6.0.0 |
| Diagrams in markdown | `mermaid`, lazy-loaded via dynamic `import()` | 11.17.2 |
| Code highlighting | `shiki` with the JavaScript regex engine | 4.4.3 |
| File-edit diffs | `react-diff-view` | 3.3.3 |
| Long transcripts | `react-virtuoso` | 4.18.16 |
| Resizable panes | `react-resizable-panels` | 4.14.1 |
| Styling | Tailwind CSS v4 with CSS custom properties for theme | 4.3.3 |
| Component library | `shadcn/ui`, components copied into `src/renderer/components/ui/` | CLI 4.21.0 |

**Rationale**: `rehype-sanitize` is the maintained sanitiser for react-markdown, which constitution V requires because agent text is untrusted. `react-virtuoso` measures variable-height rows and has built-in stick-to-bottom, which fits 30+ tool rows and streaming text. `react-diff-view` is a React component that reads unified diffs. `isomorphic-git` was rejected: it has no `worktree` command (sourced: isomorphic-git.org command index).

**GFM and Mermaid (T065, T066, built 2026-10-03)**: `remark-gfm` 4.0.1 is the maintained GFM plugin (tables, strikethrough, task lists, footnotes); no version was already pinned for it in this table, so 4.0.1 (npm `latest` on 2026-10-03) was chosen. `rehype-sanitize`'s default schema is GitHub-style sanitation (`hast-util-sanitize` `lib/schema.js`, read, not inferred) and already allows `table`/`thead`/`tbody`/`tr`/`th`/`td`, `input[type=checkbox][disabled]`, `li.task-list-item`, and the GFM footnotes `section`/`h2.sr-only`/backref `a` -- so **no schema extension was needed**, contrary to the original task wording; `Markdown.tsx`'s `components` map only adds Tailwind styling (a scrollable table wrapper, bordered cells, themed checkboxes, a footnotes divider), confirmed by live render (see tasks.md T067 verification note). `mermaid` 11.17.2 is the newest 11.x release (12.0.0 exists but is a very recent major version change, released two weeks prior to this check, so the established 11.x line was preferred); 11.17.2 postdates the fix for CVE-2026-41148/CVE-2026-41149 (classDef CSS/HTML injection, fixed in 10.9.6/11.15.0), both irrelevant to Pinion's design anyway since diagrams render to a detached SVG string, never inserted into the live DOM (`<img>` only, see the Mermaid security decision below).

**Component library (decided 2026-09-30)**: shadcn/ui. Themeable through semantic CSS-variable tokens (`--primary`, `--muted`, `--border`, and so on, with dark mode by overriding them under `.dark`), and new tokens such as `--warning` are added the documented way (sourced: ui.shadcn.com/docs/theming), which is how Refract adds its state-colour roles. Extensible because the component source is copied into the repository, so extending a component is editing it. It has about 60 components, including Message, Message Scroller, Bubble, Marker, Kbd, Command (the Ctrl+K palette), Sidebar, Resizable, Menubar, Context Menu, Empty, Dialog, Alert Dialog, and Toast (sourced: ui.shadcn.com/docs/components). Rejected: Web Awesome 3.14.0 (web components; Combobox, Data Grid, Date Picker, and charts are Pro-only, and shadow DOM fights a Tailwind-token approach), Tamagui 2.7.7 (React Native plus web; its value is not needed for an Electron-only app; only its introduction page was read), Radix Themes 3.3.0 (prop-based theming, least extensible, last published January 2026), Fluent UI v9 and Mantine (own styling systems, would replace the Tailwind decision). Not verified: whether shadcn's Message Scroller virtualises long transcripts, and that its Resizable wraps `react-resizable-panels` [INFERENCE]; T025 tries Message Scroller before falling back to `react-virtuoso`.

**Not verified**: the zustand-versus-alternatives and virtuoso-versus-TanStack comparisons are reasoning, not measurement [INFERENCE]. The Shiki JS engine is chosen to avoid WASM loading under a sandboxed renderer; it was not benchmarked. Tailwind v4 dark-mode wiring was not fetched; the first UI task checks it before the theme system is built on it.

## 3. Conversation storage and the session directory

**Decision**: Refract passes no `--session-dir`. Each Session's agent runs with `cwd = worktreePath`, and OMP's default per-cwd directory holds that Session's Conversations. Refract learns the directory once from `dirname(get_state.sessionFile)` and stores it as `Session.sessionDir`.

**Rationale (verified, FINDINGS items 11 and 17)**: two worktrees of one repository get different directories; `switch_session` and `open_session {sessionDir}` restore history when the cwd matches (`--resume` also does in the ordinary case but is not used, item 17); a bare relaunch continues nothing; a Conversation's created time is in its file name.

**Consequence**: Refract's registry stores only repository path, worktree path, name, and two pointers into OMP's data. It never parses session files beyond the first line and the first 8 KB for a title and preview.

## 4. Killing the whole agent tree when Refract dies

**Decision**: at app start, before spawning anything, the main process creates one Windows Job Object with `KILL_ON_JOB_CLOSE` (through `koffi`) and assigns itself to it (`AssignProcessToJobObject(job, GetCurrentProcess())`). Every `omp` and every process it starts inherits membership at creation, so there is no assignment race. Also keep `processes.json` (pid plus start time) and reap matching processes at start as a fallback if job creation failed.

**Rationale (verified)**: FINDINGS item 10 proved a tool subprocess survives a force-killed parent. FINDINGS item 12 proved the self-join job killed the whole omp tree (19 to 20 descendants including the tool's `ping.exe`) within 1 s with zero escapees, also when Refract itself was started inside another job (nested jobs), and inside Electron's main process. The alternative, assigning each `omp` pid after `spawn`, worked at 38 to 53 ms but let a pre-existing child (a conhost) escape in 2 of 3 runs, so it is not race-free. `koffi` installed as a prebuilt binary, no compile.

**Alternatives**: start-up reaping alone (cannot find tool subprocesses); a suspended-launch helper (would close the race completely, not built; revisit only if a run shows descendants at assignment time).

**Not verified**: that `koffi` loads inside Electron's main process (proven under plain Node). The first task checks it; if it fails, the fallback is `@electron/rebuild` or a Node child helper process that owns the job, which is decided then.

## 5. Protocol framing

**Decision**: negotiate protocol v2 and implement chunk reassembly in Refract (`src/main/omp/frames.ts`).

**Rationale**: `get_messages` and `get_state` responses can exceed the 1 MiB v1 frame cap (`get_state` carries the system prompt and every tool schema). OMP's `RpcFrameDecoder` is raw TypeScript in an npm package that needs Bun (FINDINGS C22b), so the app cannot import it. The probe scripts already contain a working reassembler to copy.

## 6. Refract's own storage

**Decision**: three JSON files in `app.getPath('userData')` (`registry.json`, `settings.json`, `processes.json`), written atomically (temp file, rename).

**Rationale**: the data is tiny and structured; `electron-store@11` is ESM-only and needs Electron 30+ with no CommonJS export (sourced: its README), forcing a module-format boundary in main for no gain. SQLite is more than needed.

## 7. Git

**Decision**: call the `git` executable directly with `execFile` from a small helper in main (`src/main/git/git.ts`), no library.

**Rationale**: only seven commands are needed (`worktree add`, `worktree remove`, `branch --list`, `rev-parse`, `status --porcelain`, `rev-list`, `symbolic-ref`), so a dependency adds nothing. `simple-git@4.0.2` was the researched alternative and would also work.

**Windows risk (sourced: Git for Windows docs)**: paths over 260 characters fail unless `core.longpaths` is set, and even then scripted git "may still fail". Worktrees go in `<repo>/../pinion-worktrees/<repo>/<name>`, so paths stay shallow; `sessions.create` reports `path-too-long` and cleans up when it fails.

## 8. Where the transcript lives

**Decision**: the main process turns OMP frames into `TranscriptItem`s and holds the full transcript per Session; the renderer receives patches for the visible Session (at most one per 50 ms) and a full snapshot when it opens a Session.

**Rationale**: a renderer reload (including dev HMR) loses nothing, and background Sessions keep streaming without renderer work. Each `message_update` frame carries the whole message so far (verified from recorded frames), so patches replace items rather than concatenate deltas.

## 9. Approval mode changes

**Decision**: restart the Session's agent with the new `--approval-mode` and reattach with `switch_session` once the Session is idle (at `session_settled`, or immediately when it is already idle with no pending request; constitution I; FINDINGS item 9). OMP has no runtime command for this (sourced: `rpc.md`, read, not probed).

**Cost**: a restart drops `providerPayload` (FINDINGS item 5) and costs a cold start of about 16 s (item 6) before the Session is usable again; the header chip says so.

## 10. Notifications

**Decision**: Electron's built-in `Notification` from main; call `app.setAppUserModelId(process.execPath)` in development, because Windows notifications need an AppUserModelID that only an installer sets (sourced: electronjs.org notifications tutorial).

## 11. Memory

**Decision (user)**: no limit on live agents. Main samples `os.freemem()` every 5 s; below 2 GB free it shows the low-memory warning with the count of live agents; the user can stop a Session's agent from the list (FR-037, FR-038). The 2 GB threshold is my default, not measured; it is a constant in `src/main/memory.ts`.

**Basis (verified, FINDINGS item 13)**: about 1.15 GB idle and 1.9 GB mid-turn per live Session with the tested MCP configuration, and free memory reached 292 MB with several Sessions live.

## 12. Theme and fonts

**Decision**: CSS custom properties define colour roles and two font variables (`--font-ui`, `--font-code`). The first build ships the dark theme, a light theme, and system defaults; the settings screen for changing them is a separate spec (issue #4). Ligatures are controlled with `font-variant-ligatures`; Nerd Font glyphs rely on the installed font in the `font-family` list [INFERENCE for the Nerd Font fallback; the property itself is sourced from MDN].

## 13. Packaging

**Decision**: none. The prototype runs with `pnpm dev` and `pnpm build` (electron-vite). An installer is a later issue. When packaging is added, `koffi`'s native `.node` binary must be unpacked from the asar archive (electron-builder `asarUnpack`) or it fails to load [INFERENCE: standard Electron native-module behaviour, not tested here].

## 14. Mermaid diagram security (constitution V, T066, 2026-10-03)

**Decision**: render a Mermaid fence by calling `mermaid.render()` -- which briefly appends a temporary div+SVG to `document.body`, applies the diagram's own classDef CSS via `style.innerHTML`, serializes the SVG, then removes the temporary node, all synchronously in the live document (read directly from `mermaid`'s source; **not** off-DOM as an earlier draft of this decision claimed) -- to get a sanitized SVG string, then show that string as a `data:image/svg+xml` `<img>`, never by inserting the SVG into the live DOM as markup (no `dangerouslySetInnerHTML`, unlike `CodeBlock`'s Shiki output). `mermaid.initialize({ securityLevel: 'strict', suppressErrorRendering: true, startOnLoad: false, theme: ... })` is also set, as defence in depth, not as the sole control. `suppressErrorRendering: true` stops a parse error from drawing Mermaid's own error diagram into that temporary node and throwing before its `removeTempElements()` cleanup runs, which previously left an orphan node in `document.body` on every invalid (or re-rendered, e.g. on a theme flip) diagram.

**Rationale (sourced, not inferred -- read mermaid.js.org directly)**:
- Browsers disable JavaScript for SVG used as an image (MDN "SVG as an image", developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image: "JavaScript is disabled" in image contexts, HTML `<img>` included). An `<img>` whose `src` is an SVG therefore cannot execute an embedded `<script>`, an `onclick`/`onerror` attribute, or a Mermaid `click` callback, regardless of `securityLevel`. This is the primary control over the FINAL DISPLAYED output, not over the render step itself (which does briefly touch the live DOM, per the corrected `Decision` above); `bindFunctions` (the function `mermaid.render()` returns to wire up click handlers) is never called, so no click handler is ever wired to anything, live DOM node or not.
- `securityLevel: 'strict'` (mermaid's own default) additionally disables click functionality and HTML-encodes label text at the Mermaid-config level (mermaid.js.org/config/schema-docs/config-properties-securitylevel.html).
- A Mermaid `%%{init: ...}%%` directive cannot lower `securityLevel` back to `'loose'`: `config.secure` defaults to `['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']` (mermaid.js.org/config/schema-docs/config-properties-secure.html), and that list is exactly "which `currentConfig` keys ... can only be changed via a call to `mermaid.initialize`" -- a directive is not such a call. Confirmed live (tasks.md T067 verification note): a fence with both a `click ... call alert(...)` callback and a `%%{init: {"securityLevel": "loose"}}%%` directive rendered as an ordinary inert diagram image; no `<script>` beyond the app's own bundle, no `onerror`/`onclick` attribute, and no new `window` property appeared afterward.
- Mermaid's own classDef-CSS/HTML-injection CVEs (CVE-2026-41148, CVE-2026-41149; fixed 10.9.6/11.15.0, this pinned version 11.17.2 postdates both) attack `style.innerHTML`/DOM injection paths inside `mermaid.render()` itself, which (corrected above) DOES run in the live document, briefly, before cleanup -- so this attack surface is not avoided by construction; the live protection during that step is version pinning past the fix, `securityLevel: 'strict'`, and Mermaid's own internal DOMPurify sanitization pass over the serialized SVG. Pinion's `<img>`-wrapper design is a separate, additional control over the FINAL DISPLAYED output (making it inert via MDN "SVG as an image" script-disabling), not a way of avoiding the render step touching the DOM at all.

**Not verified**: whether `secure` itself, being secure-listed, can be widened by a directive that adds entries removing something else from the list -- not tried; the `<img>` control above makes only the FINAL DISPLAYED SVG inert, not the brief live-DOM render step itself (see the corrected `Decision` above), so this is not moot on that basis.

## 15. Removing a repository (2026-10-06)

**Decision (user)**: a repository can only be removed from Refract once it owns zero Sessions, archived ones included -- an archived Session still owns a worktree on disk, so it counts the same as a running one for this gate. The existing `session-running` error code is retired in favour of a new `has-sessions` code: the refusal condition changed from "a Session is currently running" to "any Session still exists", so keeping the old name would describe the wrong thing, and it had exactly one caller (`repositories.remove`) to update. `RegistryStore.removeRepository` stops filtering Session records as a side effect and instead refuses (throws) when the Repository it is asked to drop still owns any Session, so the no-orphan-Session invariant (data-model.md) holds even if a future caller forgets to check first -- the IPC handler still checks first for the ordinary refusal path; the registry's own refusal is only a backstop.

**Rationale**: the pre-existing code silently dropped every Session row belonging to the removed Repository, orphaning each one's worktree, branch, and Conversation files on disk with no record left anywhere in Refract to find them again -- a data-loss bug to close, not a feature to keep. Gating at zero Sessions, not zero running Sessions, matches data-model.md's registry invariant that no Session may exist without its own Repository.

**Alternatives**: cascading the delete (removing every Session along with the Repository) was rejected -- Session deletion already has its own confirmation naming uncommitted/unpushed work (FR-029), and silently cascading past that would reintroduce the same data-loss bug this decision closes.

| Unknown | Resolved by |
|---|---|
| How OMP reports the change made by an `edit` tool call (diff source) | First chat task: read a real `tool_execution_end.result.details` |
| How to detect "OMP signed in" reliably | First readiness task: probe `get_available_models` on a fresh process; if it lists models without login, use another signal |
| `koffi` inside Electron main | First process task (decision 4) |
| Sandboxed preload output from electron-vite | First scaffold task (decision 1) |
| Cold start on an idle machine | Not needed for the build; re-measure when convenient |
| Free-memory threshold | Tune during use |

## 16. Stage/subagent transcript data model (issue #941, 2026-10-18)

**Decision**: a Stage's own batch `context` (the `task()` call's shared argument, sibling of
`tasks[]` on the wire) is read off `args.get("context")` in `src-tauri/src/omp/transcript/
subagent_items.rs`'s `read_batch_context`, and stored on the `TranscriptItem::Subagent`
variant's own new `context: Option<String>` field -- on spec index 0 only (gate round 1 fix),
never duplicated across every item of one call; a Stage formed from several `task()` calls in
one message therefore carries one `context` string per call, on that call's own first item,
and the renderer (`groupSubagentStages.ts`) dedupes/joins the distinct ones it finds.

**Correction**: `TranscriptItem::Subagent`'s own `status` field is
`SubagentStatus` (`transcript.rs:187-194`), an enum of **five** variants directly --
`Running | Done | Error | Cancelled | Exited` (serialized lowercase) -- not three. `Cancelled`
(issue #563 decision 15: a cancel/abort is not a failure, so it is never folded into `Error`)
and `Exited` (issue #489: a subagent orphaned by a crashed/restarted process) are both READ
from live frames/`SessionAgent.reconcileSubagentsOnAttach` the same direct way `Running`/`Done`/
`Error` are, not "applied elsewhere" as an earlier draft of this note wrongly implied.

**Rationale**: a worktree-root scratch file (`research.md`, written during this story's own
investigation) made this same claim inaccurately before being deleted; recorded correctly here,
the one place this repository's own Spec Kit convention keeps durable research notes.

## 17. Subagent panel Stage grouping and "Up next" gating (issue #941 part 2, 2026-10-18)

**Decision (Skippy, delegated by Stuart 2026-10-18)**: the Subagents panel groups its own flat
`SubagentSummary[]` by `toolCallId` alone (the only correlation key that interface carries --
no `messageId`/`context`, confirmed against `src/shared/model.ts`), never merging several calls
that share one assistant message the way the chat pane's own `messageId`-keyed
`groupSubagentStages.ts` can. A call with exactly one member stays a single flat row (nothing to
group, unchanged from before part 2); 2+ members get a Stage header row with its real members
nested one level deeper. The header's own label always uses `computeStageLabel`'s "no context"
fallback tier (shared name prefix, else `null`) -- the panel has no per-call `context` to read
the first tier from. The "latest earlier occurrence wins" dependency algorithm is a single
shared `resolveStageDependencies` (`stageMeta.ts`), called by both `groupSubagentStages.ts` and
this panel grouper, keyed on each item's own real agent name -- gate-fix: `SubagentSummary.id`
is `${toolCallId}:${nameOrTask}` (`subagents.rs::handle_task_start`'s own `base_id`), never the
bare name alone, so the correct key is `nameOrTask`, not `id` (the `model.ts` doc comment this
was first built against claimed otherwise; corrected there too).

**Decision (Skippy, delegated by Stuart 2026-10-18; ui-architect-v3 ruling, gate round 1): a
Stage header's own label in the panel never shows "Stage N"**. The panel numbers its own Stages
session-wide by `toolCallId` (in the order calls were made across the whole Session); the chat
numbers Stages per TURN (`groupSubagentStages.ts`'s own `stageIndex`, reset to 1 at the start of
every turn). The SAME underlying `task()` call therefore carries two DIFFERENT "Stage N" numbers
across the two surfaces whenever a Session has run more than one turn with Stages -- showing a
number in the panel would read as contradicting the chat's own number for what is visibly the
same work. Fixed by never stating a number in the panel: the header shows the shared name prefix
when one exists, else a bare "N agents"; a header's own real "Uses:" dependency renders as plain
NAMES ONLY ("Uses: G923Code"), never "(Stage N)", scoped to agents an EARLIER call in the
session actually started (the same resolution the chat performs, just never surfacing the
number it resolves to). A solo call's own dependency is intentionally not shown in the panel (no
header row exists there to attach one to); it stays visible in the chat.

**Decision (Skippy, delegated by Stuart 2026-10-18)**: the "Up next" Todo-phase list renders
once per TURN (not once per Stage), gated on `isLastTurn` (the same boolean `Transcript.tsx`
already computes for `TurnTotalLine`) -- `ReadoutState.todoPhases` is the agent's own CURRENT
session-scoped state, not a per-turn snapshot, so showing it after every past turn with a Stage
would repeat the identical list. Also gated on that turn having at least one Stage
(`stages.length > 0`): "below the Subagent chain" has no anchor point in a turn that never ran a
`task()` call at all.

**Correction (gate round 1, item 8)**: an earlier draft of this note claimed `compute_up_next`
(`src-tauri/src/session/readout_todo.rs`) is gated by `state_synced` "the same way `contextUsage`
is" -- re-read, this is NOT true: `compute_up_next` takes only `Option<&Vec<TodoPhaseState>>` and
never reads `state_synced` at all; `context_usage`'s OWN build function (`build_readout_value`)
is the one with a THREE-state branch (`Some(data)` / `state_synced`-gated `"not-available"` /
`null`), a distinction `todoPhases`'s own UI never needed (it only ever shows-or-hides, no
"not available yet" text). No stale-data bug exists regardless: `on_conversation_reset` already
explicitly nulls `s.todo_phases` (and sets `state_synced = false`) BEFORE the new Conversation's
own first `get_state` response can repopulate it, so the renderer can never observe a previous
Conversation's own stale phases through this field -- an extra `state_synced` check on
`compute_up_next` itself would be redundant, not a fix. Left uncommented in Rust; this note is
the correction.

**Note (gate round 3)**: a panel Stage header never collapses -- `SubagentPanel.tsx`'s own
`aria-expanded={row.node.isStage ? true : undefined}` is always the literal `true`, with no
toggle control and no `aria-selected` either (a header has no single subagent id to select or
collapse); its real members are always rendered nested beneath it. `ArrowRight` on a header row
moves focus into its first member (same file, `handleRowKeyDown`); there is no corresponding
"collapse" action anywhere in this tree.

## 18. Slash refusal text, notice wrap, and the #938 item 6 duplicate-render investigation (2026-10-18)

**Decision**: `ipc::chat`'s refusal for an `UnsupportedArguments` command distinguishes two
cases via `classify_unsupported_arguments` (`src-tauri/src/session/agent/commands.rs`): when the
typed first word is not one of the command's own verified subcommands, it lists them by name
("/advisor takes one of: on, off, status."); when that first word IS a verified subcommand but
more text follows it, it instead says so directly ("/advisor on doesn't take more text yet. Try
/advisor on on its own.", `ui-architect-v3` roundtable ruling). Both branches resolve the
descriptor through one shared `resolve_matched_descriptor` helper -- also used by
`classify_slash_invocation` itself -- so a refusal's own presentation can never resolve a
DIFFERENT descriptor than the one that actually produced it. `NoticeRow.tsx`'s short-notice
branch gets `summaryWrap` rather than becoming expandable (same roundtable ruling).

**Alternatives (notice wrap)**: making every short notice expandable (matching the long-notice
branch's own chevron) was rejected -- the common case has nothing behind the chevron (no second
paragraph, just the same one clause re-wrapped), so the control would be a dead end most of the
time; `summaryWrap` is the system's existing no-children escape hatch for exactly this shape of
problem (already used by the Subagents panel for a long path/paragraph).

**Investigation (issue #938 item 6, not a bug -- corrected, gate round 1)**: a first draft of
this note wrongly attributed the #917/#954 screenshots' doubled sentinel text to the live-check
scripts' own wait condition (prompt plus one reply = 2). Re-read against the actual OMP session
log (`~/.omp/agent/sessions/.../2026-10-16T11-14-21-749Z_....jsonl`): the model called the
hidden `todo` tool (`HIDDEN_TOOLS`, never rendered as its own row) then replied `"t917turn"`
(message `62b79278`) and stopped; OMP's own incomplete-todo nudge (`"You stopped with 1
incomplete todo item(s)"`, a `developer`-role reminder, line 15) made it continue, mark the todo
done, and reply `"t917turn"` a SECOND time (message `bc1f768c`) -- two genuinely distinct
assistant messages, each with its own `message_id`, each correctly rendered once. A second,
independent #954/#947 verify run's own session log
(`~/.omp/agent/sessions/.../2026-10-18T03-23-16-685Z_....jsonl`, messages `6e0a81f1`/`00f9bf00`)
shows the IDENTICAL shape against `"t947turn"`, confirming this is the general mechanism (the
incomplete-todo nudge), not a one-off. `build_assistant_items`/`apply_message_snapshot`/
`replace_message_items` (`src-tauri/src/omp/transcript.rs`) apply every assistant message
snapshot (`message_start`/`message_update`/`message_end`) as a full replace keyed by
`message_id`/`message_id:index`, stripping every existing item under that key before inserting
the fresh set -- there is no code path that can render one message's own content index twice.
The #917 screenshot's THREE occurrences (not two) are: the user's own prompt bubble (the
instruction text itself contains the sentinel word once), plus these two real, separate
assistant replies. Not a duplicate render; `role="log"` announces each of the three rows exactly
once, as it should. No code change.

## 19. Stage row focus and toggle follow-ups (issue #991, 2026-10-18; renumbered from a
provisional decision 18 once #938/PR #996 claimed it on `origin/main` first)

**Decision (ui-architect-v3 ruling, posted on issue #991)**: `StageGroupRow`'s own open/close
sync effect (`SubagentChainRow.tsx`) changes from bidirectional ("sync `open` to
`isOpenByDefault` whichever way it moves") to upward-only -- a multi-agent Stage still
auto-opens while running/failed/cancelled/exited, but once open (by auto-open or the user), it
stays open until the user collapses it themselves. This matches the per-turn Subagent chain
row's own rule, already decided this way during the #941 gate (2026-10-18, "sync UPWARD only,
never auto-close -- an untouched row closing itself the instant everything finishes would
collapse Stage rows the user expanded mid-read and drop their focus"). The "documented design"
rationale the #941 gate used to defer this (treating the Stage row as a deliberately different,
always-auto-closing case) does not hold up under re-reading: before #941 the row used an
uncontrolled `defaultOpen` prop, which Radix reads only once at mount and never re-applies, so a
Stage settling to green in place never actually auto-closed before #941's own mount-bug fix went
in (`dc80999`) -- the bidirectional sync was a side effect of that fix, not a separately
considered original choice. Removing the auto-close resolves two of #991's four items at once:
the a11y defect (a keyboard user's focus inside the content can no longer be dropped by an
automatic Radix unmount, since the only remaining way to close the row is the user's own
activation of its own trigger, which already holds focus at that moment) and the "mouse user
reading it when it closes" annoyance (there is no longer an automatic close to interrupt either
kind of user). Follow-up filed, not built here: issue #1000 (Stage rows auto-opening AND the
chain row both showing every agent once a turn has 2+ Stages; narrows the auto-open condition to
failed/cancelled/exited only in that case) and issue #1001 (a solo Stage's own body swapping for
a `SpineList` can still drop focus, pre-existing from #941).

**Decision**: `userToggledRef`/`open`, for both the Stage row and the Subagent chain row, move
out of a plain `useRef`/`useState` pair into a new `useStageToggleStore`
(`src/renderer/state/stage-toggle-store.ts`), keyed by session id plus the row's own stable id
(a Stage's own `group.id`; `chain:<first stage id>` for the chain row, which has no id of its
own). Non-persisted, in-memory only -- same convention as `alert-dismiss-store.ts`: reset only
by a full app restart, never written to `settings.json`/disk. This survives the kind of remount
named in the issue: a session switch, where a different Session's own row set replaces this
one's through ordinary keyed-list reconciliation (gate round 1/2 correction below has the full,
corrected mechanism).

**Decision**: `scripts/verify-941-stage-naming-helpers.mjs`'s `titleSelector` (a plain
`document.querySelector('[title="..."]')`) only ever found the right Stage because a turn's
Stage rows render earlier in the DOM than the chain row that repeats the same label text in its
own `ChainStageLine` once open (its default state). Scoped instead to an element whose closest
ancestor is a real per-position row (`data-slot="message-scroller-item"`,
`MessageScrollerItem`) -- the chain row renders directly in the turn's own `React.Fragment`,
with no such ancestor, so this can never match its own duplicate regardless of DOM order.

**Gate round 1 correction (ui-architect-v3/code-reviewer/test-reviewer, unanimous)**: the store
above was staging both the auto-open latch AND the user's own manual choice together, which
code-reviewer flagged as unnecessary coupling and ui-architect-v3/test-reviewer confirmed was
the wrong persistence boundary -- the auto-open latch needs no persistence at all (recomputing
it fresh on every mount is already correct), so only a deliberate user override belongs in the
store. Redesigned: `useStageToggleStore` now holds only `bySession: Record<string,
Record<string, boolean>>` (the manual choice alone, same shape as `draft-store.ts`); the
auto-open latch moved into a new shared `useStickyDisclosure` hook's own local component state,
which also folds the two rows' previously-duplicated toggle logic into one place (code-reviewer,
DRY). The remount description above is also corrected: `<Transcript>`/`ChatPane` carry no
explicit `key` -- a session switch unmounts a Stage/chain row through ordinary keyed-list
reconciliation (a different session renders a different row-id set), and `Transcript.tsx`'s own
sr-only-stub/full-row visibility swap is a second, separate path that can unmount and remount
the same row id.

**Gate round 1 correction (test-reviewer)**: the selector-scoping fix (`titleSelector`) cannot
be proven as a red/green regression against this exact fixture, since Stage rows always render
before the chain row in `Transcript.tsx`'s own DOM order -- even the OLD unscoped selector would
already resolve correctly here. The live check records this as order-independent hardening
(proved by a count check confirming the duplicate genuinely exists, plus the ancestor-based
disambiguation), not a demonstrable fix of an actual failure in this fixture.

**Gate round 1 correction (accessibility-auditor)**: "no more path left that drops focus" (an
earlier draft's wording) overclaimed -- corrected to "no more AUTO-CLOSE path": a solo Stage's
own body (`SubagentBody`) still swaps for a `SpineList` the instant a second agent streams into
the same Stage, which can still unmount whatever was focused inside it (a separate, pre-existing
defect from #941, filed as its own follow-up by Main as issue #1001, not fixed by this change).

**Gate round 2 correction (code-reviewer)**: an earlier draft of the decision above claimed the
chain row "fully unmounts whenever a turn's Stage count drops back below 2 (`if (stages.length <
2) return null`) and later rises again" -- re-read, this is NOT true: returning `null` from a
component does not unmount it or reset its hooks; React keeps the exact same instance, with
every hook's own state intact, and simply paints no output for that render. The only genuine
remount this store/hook pair needs to survive is the session-switch case the gate round 1
correction above already describes correctly (ordinary keyed-list reconciliation, plus
`Transcript.tsx`'s own sr-only-stub/full-row visibility swap).

**Gate round 2 fix (code-reviewer, LOW)**: `useStickyDisclosure`'s own `open` value used to read
`manualOpen ?? latchedAutoOpen` -- since the latch's own `useEffect` only commits
`setLatchedAutoOpen(true)` on the render AFTER `autoOpen` first turns true (effects run
post-commit, not during the same render), this showed one stale closed frame the instant a
Stage started running. Fixed: `manualOpen ?? (latchedAutoOpen || autoOpen)`, ORing in the
CURRENT `autoOpen` value closes that one-render lag; the effect still matters for holding the
latch `true` on a LATER render once `autoOpen` has already swung back to `false` again, which
the OR alone cannot do by itself.

**Decided (Skippy, delegated by Stuart 2026-10-18, gate round 2, UI Lows)**: two edge cases in
the redesigned toggle, both confirmed as intended behaviour, no code change --
1. A toggle attempted on the chain row before its own row id exists (`turnKey` undefined only
   while `stages` is empty) is dropped by design -- this only ever happens while
   `stages.length < 2`, the same range the chain row itself renders `null` for (which also
   covers a turn with exactly one Stage, where the row id IS already defined): it falls back to
   local-only state for that render, never persisted, and there is nothing visible for a user
   to have toggled in the first place either way.
2. A user's own manual CLOSE on a Stage is never overridden by a LATER failure on that same
   Stage (`autoOpen` swinging back to `true`): `open = manualOpen ?? (...)` means a defined
   `manualOpen` always wins, by design -- the user's choice to keep a Stage collapsed is
   respected even once it fails. Gate round 3 correction (UI): the failure is NOT surfaced by a
   toast (none exists for a Stage failure) -- it still surfaces through the CLOSED Stage's own
   header (its red icon and "N done, M failed" roll-up render regardless of expand state), the
   per-turn chain row's own roll-up (only when the turn has 2 or more Stages), and the
   screen-reader-only settle announcement.

## 21. Stage rows defer running auto-open to the chain row (issue #1000, 2026-10-18; takes the
next free decision number -- open PR #1003 is independently using decision 20 on its own
branch, not yet merged, expect renumbering at merge per the branch's own convention above)

**Problem**: FR-084/decision 19's own upward-only fix means a multi-agent Stage row still
auto-opens the instant any of its own agents is running, and stays open permanently once it
does (the sticky latch). In a turn with two or more Stages, the per-turn Subagent chain row
(FR-068) ALSO lists every agent, with its own default-open-while-unsettled rule -- so a turn
with several running or recently-settled Stages shows the SAME agents expanded twice over, once
in each Stage's own row in place, again in the chain row's own body.

**Decision (Skippy, delegated by Stuart 2026-10-18, ruling by ui-architect-v3 at PR #999's own
gate, recorded on issue #1000)**: once a turn has two or more Stages, a Stage row's own
`isOpenByDefault` (`StageGroupRow`, `SubagentChainRow.tsx`) drops `running` from its auto-open
condition -- only `failed`/`cancelled`/`exited` still auto-open it. The chain row already
carries the live running overview for the whole turn the moment it renders (`stages.length >=
2`), so a Stage settling in place no longer needs to duplicate that same overview itself. A
turn with only one Stage keeps today's existing running auto-open unchanged (FR-067): there is
no chain row yet (it renders nothing below two Stages) to carry an overview for it, so nothing
is gained by deferring there. **Declined alternative** (named in the issue): collapsing an
untouched previous-turn row on the next send -- brings back auto-close and the exact focus-drop
defect decision 19/#991 removed, and risks a scroll shift from the `content-visibility` rows
the same way #991's own research already flagged for that alternative.

**Grilled and decided (no further design input needed -- a technical-semantics question, not a
product one)**: what counts as "a turn has two or more Stages" while a later Stage has not
started streaming yet, so only one Stage currently exists? Read `StageGroup.totalStages` live,
exactly as it already is (`groupSubagentStages.ts` recomputes it, as `stages.length`, on every
grouping pass over the transcript items known SO FAR) -- the renderer has no way to know in
advance how many Stages a turn will eventually have, so there is no other implementable answer.
Concretely: while a turn's first Stage is the only one that exists, it is treated as a
single-Stage turn and keeps auto-opening while running (unaffected by this decision); the
instant a second Stage's own first item streams in, `totalStages` becomes 2 for every Stage in
the turn (the `stages.forEach(...)` pass in `groupSubagentStages.ts` stamps the SAME final
count onto every entry), reclassifying all of them, including one already auto-opened while
running under the single-Stage rule. Does an already-open Stage close itself at that moment?
No, and no extra code is needed to guarantee it: `useStickyDisclosure`'s own upward-only latch
(decision 19) is set from the EARLIER render where `autoOpen` was still true and persists in
local component state for the whole mount, regardless of any later recompute of the auto-open
CONDITION itself -- `open = manualOpen ?? (latchedAutoOpen || autoOpen)` stays true even once
`autoOpen` itself later reads false. A Stage this decision exempts from auto-open is never
exempt from the USER's own manual toggle either (FR-084 unchanged): a user may still open it by
hand while it runs, and once open that way, decision 19's own upward-only rule applies exactly
as it already does to any other row.

**Gate round 1 fix (code-reviewer, Medium; Decided, Skippy, delegated by Stuart 2026-10-18, UI
architect's suggested fix)**: the condition above must not wait for a Stage's own OVERALL
`status` to settle before opening it -- `overallStatus` reads `'running'` for as long as ANY
member is still unsettled, even once a DIFFERENT member in the same Stage has already failed,
cancelled, or exited, which would silently delay the open until the whole Stage finally
settles. Fixed: `hasBadMember` reads the raw `counts.failed`/`counts.cancelled`/`counts.exited`
directly, so a multi-Stage Stage opens the instant any ONE of its own members goes bad, even
while a sibling is still running.

**Gate round 1 correction (code-reviewer, UI, Medium)**: a fresh mount of an already-settled,
already-multi-Stage turn (reopened history, or a remount) is a DIFFERENT case from the live
transition described above -- it renders every Stage in one single pass, already knowing the
turn's final Stage count, so a first Stage that never itself had a bad member computes
`isOpenByDefault` under the multi-Stage branch on its one-and-only render and starts CLOSED,
same as any other untouched Stage in that turn. This is not a regression: there is no earlier
single-Stage render for such a mount to have latched an auto-open from in the first place --
the live-transition guarantee above only ever applies to a Stage that was genuinely observed
running while it was still this turn's only Stage.

**Live check** (`scripts/verify-1000-stage-defer.mjs`): the `stages-941.jsonl` fixture gained a
SECOND additive `{"__delay__": 1500}`, mirroring Stage 1's own existing one (decision 19/#991),
inserted after Stage 2's own assistant-message echo and before its `tool_execution_end` -- the
only window in this fixture where a Stage is genuinely, observably running while the turn
already has two or more Stages. "Running" is read from the Stage's own TRIGGER `aria-label`
(which always renders, open or closed, and states the live status word), never the collapsible
CONTENT (Radix does not render it while closed -- Stage 2 staying closed while running is
exactly the behaviour under test, so a content-based check would time out and silently mask
the whole proof; gate round 1 fix, Critical). Proves: Stage 2 stays closed while running at
that point (red on `origin/main`, where it would auto-open unconditionally); the chain row is
already open and shows "2 stages"/"Running"; Stage 1 (opened earlier, single-Stage-so-far) does
not close itself once the turn grows past it (a screenshot is taken immediately after this
point, before anything manually touches Stage 2, gate round 1 fix, Medium); after the whole
ten-Stage turn settles, Stage 3 (two agents, never failed, never manually touched anywhere in
this script) stays closed -- the clean "settled and never touched stays closed" proof (gate
round 1 fix, Medium: Stage 2 itself is used below for the manual-open/focus proof instead, so
its own post-settle state is no longer a "never touched" witness); Stage 5 (its own FailAgent
member failed) is open regardless of Stage count (the kept exception); a user's own manual open
on Stage 2 plus keyboard focus placed inside it while running survives both it settling and
every later Stage streaming in behind it (WCAG 2.4.3, re-proving decision 19's own guarantee
for a Stage this decision newly exempts from auto-open). If the additive delay window is ever
missed, the run records it in `notExercised` and is NOT permitted to report DONE/exit 0 -- a
distinct NOT-PROVEN verdict and exit code (2) instead (gate round 1 fix, Medium), since nothing
would have genuinely distinguished the fix from `origin/main` that pass. This is a pure
wall-clock pacing addition: no JSON field (status, `durationMs`, `resultText`) changes anywhere
in the fixture, so every existing content-dependent assertion against it is unaffected --
confirmed by re-reading `verify-941-stage-naming-panel-helpers.mjs`'s own Story559
duration-based disambiguation ("2s" from Stage 2's 1800ms, "4s" from Stage 5's 4300ms, never
confused) and `verify-941-part2.mjs`'s own position-scoped `EXPECTED_PANEL_ROWS` structure
check, neither of which depends on real-time pacing.
`scripts/verify-941-stage-naming-helpers.mjs`'s own Stage 1 `'true'` expand-cycle expectation
(decision 19/gate round 3) and `scripts/verify-991-stage-focus.mjs`'s own
focus-survives-settling phase both still hold unchanged: Stage 1's own render during ITS delay
window is still single-Stage-so-far (Stage 2's new delay runs strictly later in the tape), so
it auto-opens exactly as before either way.
