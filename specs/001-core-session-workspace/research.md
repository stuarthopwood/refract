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
## 20. Async-result job matching must be Stage-scoped, not bare job_id/label (issue #989, 2026-10-18)

Filed by the #941 lane from PR #979: `apply_async_result_jobs` (`subagent_items.rs`) matched an
async-result frame's `details.jobs[]` entries against EVERY `subagent` item built so far in the
whole turn, keyed only by the bare `job_id`/`label` string, with no scoping to the `tool_call_id`
that actually issued the call. A job's own wire `id` is just its `label` echoed back verbatim --
never a session-unique value -- so two Stages running a same-named subagent (the `stages-941.jsonl`
fixture's own "Story559", Stage 2 then Stage 5) produce two unrelated jobs sharing the identical
`id`/`label` string. Stage 2's own Story559 item resolves its `job_id` as soon as Stage 2's own
`apply_batch_task_result` reads its `progress[].id`; when Stage 5's own LATER async-result
(`msg-ar5`) arrives, its "Story559" job matched BOTH Stage 5's own fresh item (correct) AND Stage
2's already-settled one (wrong), clobbering Stage 2's `result`/`duration_ms` with Stage 5's data
("Implemented the fix for #559.", 1800ms -> "Polished Story559 follow-up items.", 4300ms). The
async-result message carries no `tool_call_id` of its own to scope against (checked against
`stages-941.jsonl`, the only one of this repo's omp-frame fixtures that carries any
`async-result` message at all -- `subagents.jsonl`/`subagents-background-turn.jsonl` have none):
`details` is always exactly `{ jobs: [{ id, label, status, resultText | errorText,
durationMs }] }`, so the issue's own suggested "scope to the frame's own `tool_call_id`" cannot
be built literally.

**Decision (Skippy, delegated by Stuart 2026-10-18)**: scope matching to the item's own
resolution state instead of a wire field that does not exist. Each job in one async-result frame
claims at most one item, so two jobs in the same frame can never resolve onto the same row. No
omp/wire-format change requested: there is no `tool_call_id` on this frame to ask omp to add
scoping against, and this Rust-side scoping is sufficient. `job id == label` is a FIXTURE-
OBSERVED assumption, not a documented wire guarantee -- the real `parentToolCallId` field (the
subagent_lifecycle/progress/snapshot RPC payloads, `rpc-wire.schema.json`) is the eventual true
scoping key once #712's not-yet-wired-up subscription path (section 16-17 above) is built.

**Gate round 1 correction (`agent://Main`, 2026-10-18)**: the first version of this decision
scoped eligibility to `result.is_none()` alone, which under-protects two ways. (1) **Settlement
requires a REAL result**: a job carrying no `resultText`/`errorText`/`schema.data` at all (the
`wait` tool's bare completion shape, e.g. `subagents-background-turn.jsonl`'s "gamma" job, line
35) only ever gets the label-echo fallback -- treating that as "resolved" would wrongly lock the
row against a later, genuinely-real job for the same `job_id`. Fixed by tracking settlement with
a dedicated Rust-only `async_settled` flag (`TranscriptItem::Subagent`, `#[serde(skip)]`, no
wire/TS counterpart), set `true` only when a job's real data resolves the row. (2) **`job_id`
must not out-rank a label match on priority alone**: the first version tried every unsettled
item's `job_id` match before ANY label match, globally -- but `apply_batch_task_result` (the
SAME Stage's own `tool_execution_end`) sets an item's `job_id` from `progress[].id` well before
its own async-result ever arrives, including on a batch-level failure with no result at all.
Hand-traced repro (gate round 1, not executed against a real build): Stage 2's Story559 errors
at the batch level with no result (status Error,
`job_id` already `"Story559"` from its own progress, still unsettled); Stage 5's LATER
async-result for its own, different Story559 job then arrived, and because `job_id` matches were
tried first regardless of recency, Stage 2's row (an unsettled `job_id` match) was wrongly chosen
over Stage 5's own fresh item (only a label match) -- the exact #989 clobber this decision was
meant to prevent, just reintroduced through a different combination of unsettled rows. Fixed by
pooling `job_id` and label matches into ONE candidate set with no match-type priority at all; the
candidate with the latest `started_at` wins (Stage 5 started after Stage 2, so it correctly wins
once pooled). (3) **Idempotency**: the live pipeline runs the identical async-result message
through `apply_message_snapshot` TWICE (`transcript.rs`'s `message_start` then `message_end` call
sites both carry the same already-complete `details.jobs[]`) -- with settlement now gated on a
REAL result, the first application settles the correct row; before hunting for a target, a job
whose `job_id` an already-settled row holds, with that row's current status/result/duration
already matching what re-applying it would write, is now recognised as a pure duplicate and
short-circuits to a no-op rather than going looking for a second row to land on. All three fixes
traced by hand together against the Stage 2/Stage 5 repro above (not executed against a real
build): first application (message_start)
settles Stage 5 correctly (pooled selection, latest `started_at`); second application
(message_end) recognises the now-settled Stage 5 row already matches and no-ops; Stage 2 is never
touched by either application.

**Gate round 2 correction (`agent://Main`, Code Critical + Design + Q1, 2026-10-18)**: round 1
shipped a compile error (`upsert_subagent_items` lost its own `existing_pos` binding during the
rewrite -- restored, `subagent_items.rs:88`) and two further design gaps.

**Design change (Code reviewer's option 2)**: rather than defending against the SAME
async-result message landing twice, stop it from being applied twice at all. A custom
`async-result` message's jobs are now applied exactly ONCE, on `message_end` only
(`apply_message_snapshot`'s own `streaming` flag is `false` only for that call site;
`message_start`/`message_update` both carry `streaming: true` and are skipped) -- matching what
`items_from_history` already did (applies each stored message once). A custom message is never
token-streamed, so it never gets a `message_update` at all, and `message_start`/`message_end`
arrive back to back with no other frame between them for every one of `stages-941.jsonl`'s ten
async-result messages (e.g. `msg-ar1` at lines 66/67 of the raw fixture file) -- skipping the
`message_start`
application leaves no user-visible gap, since nothing it would have rendered differs from what
`message_end` renders one frame later. Round 1's value-based idempotency no-op check is
therefore DELETED outright (it is no longer needed, and could itself wrongly no-op a genuinely
NEW job that happened to already match a settled row's current values).

**Ranking correction (Q1)**: round 1's "no match-type priority at all, pure latest-`started_at`"
rule reopens the #989 clobber through a different combination of unsettled rows, as the gate
round 1 repro itself showed once traced further: a batch-failed Stage merely being "unsettled"
is not the same as it still genuinely being in flight. Replaced with THREE ranked tiers, each
only a tie-break for the one before it: (1) a still-**Running** row beats one already ended by
its own batch result (Error/Cancelled/Done without a real async result yet); (2) a `job_id`
match beats a label-only match; (3) the latest `started_at` wins any remaining tie. Traced
against three scenarios:

- **(a) Sequential repro** (Stage 2 batch-errors, no result, picks up `job_id="Story559"` from
  its own progress, status Error/not-Running, unsettled; Stage 5 later, Running -- gate round 3
  correction: Stage 5's row is ALSO a `job_id` match here, not a label-only one, since its own
  `apply_batch_task_result` already reads `progress[].id` and sets its `job_id` to `"Story559"`
  before its own async-result ever applies, exactly like Stage 2 -- the only real difference is
  Stage 5 is still Running): tier 1 alone decides it -- Stage 5's key starts `(true, ...)`,
  Stage 2's starts `(false, ...)`, so Stage 5 wins outright regardless of either row's match
  type, the other two tiers never consulted.
- **(b) Concurrent trace** (A: Running, already carries this job's own `job_id`; B: Running,
  later `started_at`, label-only match): tier 1 ties (both Running); tier 2 decides it -- A's
  `job_id` match beats B's label-only match, so A wins even though B started later. This is the
  gate round 2 Q1 answer verbatim: "A must win".
- **(c) The real committed fixture's own Stage 2/Stage 5 path**: Stage 2 settles via its own
  REAL `msg-ar2` well before Stage 5 even starts, so by the time Stage 5's `msg-ar5` is
  processed (now only once), Stage 2 is excluded entirely at the settlement filter -- Stage 5 is
  the only candidate left and wins trivially, unaffected by the ranking tiers at all. This
  confirms the fixture itself never exercises scenario (a) or (b) directly (both are proven by
  hand-trace only, not by a live run of this fixture -- see `notExercised`).

**Known, accepted limit**: any overlap of two same-name jobs whose own async-result is still
outstanding, both still Running when the shared-name job arrives (tiers 1 and 2 both tie) --
tier 3's `started_at` tie-break is a best-effort guess, not a real correlation key, since this
frame carries no `tool_call_id`/`parentToolCallId` to settle it for certain. Not fixed here;
the real fix is #712's `parentToolCallId` once that subscription path is wired up. Tier 1 itself
can also swap a result the OTHER way (gate round 4, `agent://Main`): row A already ended its own
batch call but is still unsettled (genuinely owed its own real async-result, not yet delivered),
row B is a later, same-named Stage still Running -- a job meant for A can still land on B
instead, since tier 1 always prefers the Running row regardless of which row the job actually
belongs to; A then never settles. FR-085's guarantee is narrowed to sequential Stages
accordingly (spec.md Clarifications, gate round 2 entry, supersedes the gate round 1 entry
above).

**Gate round 3 correction (`agent://Main`, Code FAIL, 2026-10-18)**: item 1 required settling,
from the REAL installed omp binary's own source rather than the fixture, whether omp's RPC
stream actually guarantees a `message_end` for a custom `async-result` message. Answer: YES,
unconditionally. Extracted the bundled JS source embedded in the installed `omp.exe` (version
`18.11.1`, confirmed via `omp --version`; no separate npm/bun-global install exists to read
source from directly, so the compiled binary's own embedded strings were read instead) and
found `packages/agent/src/agent-loop.ts`'s own `rt(e, t)` helper -- the ONE place in the entire
221 MB binary that constructs a `{ type: "message_start", ... }` frame object literal:
```js
function rt(e, t) {
  for (const o of t) {
    e.push({ type: "message_start", message: o });
    e.push({ type: "message_end", message: o });
  }
}
```
Every message this agent loop appends -- including an async-result custom message, built by
`packages/coding-agent/src/session/async-job-delivery.ts`'s own `bQe(u)` function (`{ role:
"custom", customType: "async-result", content, display: true, attribution: "agent", details:
{ jobs: [...] }, timestamp }`, confirmed matching this repo's own fixture/Rust shape field for
field) and appended the same way as any other message (`e.messages.push(s); t.push(s);
rt(o, [s])`) -- goes through this exact pair, with no other code path anywhere in the binary
that pushes a `message_start` without an immediately-following `message_end`. This settles item
1 in favour of the gate-round-2 design (apply at `message_end` only): it is not merely a
fixture assumption that happens to match `stages-941.jsonl`'s own synthesized shape (that
fixture's own header comment says plainly "SYNTHESIZED, not captured live") -- it is the real,
confirmed behaviour of the shipped omp binary every Refract user actually runs.

**Gate round 3 fix 2 (`agent://Main`, HIGH, Code)**: the same `bQe(u)` builder confirms real omp
always sets `display: true` on an async-result message. Before this fix, a `message_start` frame
(its own job application skipped by the gate-round-2 design) fell through every other `custom`
arm to the plain `display == true` Notice branch, leaving a permanent Notice row (the raw
job-summary text) that `message_end`'s own `try_apply_async_result` call never replaces or
removes (nothing tracks the earlier Notice by `message_id` for removal once a later frame for
the same message applies a *different* kind of update). Fixed by short-circuiting on
`custom_type == ASYNC_RESULT_CUSTOM_TYPE` before any other `custom` arm (`transcript.rs`): an
async-result message now never builds a Notice/advisory/agent-message item at ANY frame on the
LIVE path -- `message_start`/`message_update` apply nothing and leave the transcript unchanged;
`message_end` is the only frame that ever applies its jobs. The separate HISTORY replay path
(`items_from_history`) keeps its own, unchanged fallthrough: a stored async-result message with
no `details.jobs` at all still falls through to the same checks.

**Gate round 3 fix 3 (`agent://Main`, LOW, Code, decided)**: tier 2 (`job_id` beats label-only)
now only applies BETWEEN two rows that are both still Running -- a `job_id` match from a row
that is itself not running (stale, from an earlier batch failure) must never out-rank a
label-only match just because it shares this job's `job_id`; among two not-running rows, tier 2
ties and tier 3 (`started_at`) decides directly. Known-limit sentence above widened accordingly.

**Gate round 3 doc corrections (`agent://Main`, MEDIUM, Test)**: the earlier claim that
`subagents.jsonl`/`subagents-background-turn.jsonl` were "checked against every async-result
frame" was wrong -- neither fixture contains any `async-result` message at all; only
`stages-941.jsonl` does, and only that fixture was ever actually checked. The `msg-ar1`
`message_start`/`message_end` pair cited above sits at raw file lines 66/67, not 19/20 (the
earlier citation came from a filtered line array with comment/blank lines stripped, not the real
file). Trace (a)'s Stage 5 row is corrected above to a `job_id` match, not label-only.

**Gate round 4 (`agent://Main`, Code/Test/Sec all PASS, one follow-up)**: `stages-941.jsonl` now
carries `"display":true` on every one of its ten async-result messages (both `message_start`/
`message_end`), matching real omp, so the live check can actually exercise the gate-round-3 fix
2 Notice-leak regression; `scripts/verify-941-part2.mjs` gained a check scanning the whole
Transcript for `NoticeRow`'s own `sr-only` level marker ("Info:"), since every async-result
message's own `content` is `""` in this fixture and a bare substring match would never fire
regardless of the bug -- the row's existence, not its text, is the only reliable signal.

## 21. Conversation preview/title bounded-read cap (issue #862, 2026-10-18; renumbered from a
provisional decision 22 once #1003 claimed decision 20 on `origin/main` first)

**Problem**: `conversations.rs`'s `read_preview_window` read a single fixed `PREVIEW_SCAN_BYTES
= 8 * 1024` byte buffer and looked for the first `role: 'user'` message only inside it; finding
none, `read_conversation_file` returned `None` and `list_conversations` silently skipped the
whole file. OMP's own prelude between the session header and the first user message -- a
`model_change`, `thinking_level_change`, and `service_tier_change` entry, then (newly) a
`memory_recall` `custom` entry (about 8.6 KB observed) plus `eager-todo-prelude`/
`eager-task-prelude` `custom_message` entries -- pushed real-world first user messages to about
11 KB, well past that window, so an increasingly common Conversation vanished from the history
list entirely with no error.

**Alternatives considered**: (a) raise the fixed window's size -- rejected, since any fixed size
can still be exceeded by a future OMP prelude entry (this is the second time the assumption has
broken; `docs/spike/FINDINGS.md` item 11 originally recorded "within the first 8 KB" as an
observed fact, not a documented OMP guarantee). (b) read the whole file -- rejected, the issue's
own acceptance criteria require staying cheap for the 14+ MB files already observed in the wild.

**Decision**: `read_conversation_file` reads through a `tokio::io::AsyncReadExt::take(
PREVIEW_SCAN_HARD_CAP_BYTES)`-limited handle (a hard cap on bytes actually read from disk, not
merely a byte count checked between complete lines -- gate round 1 correction below), streaming
complete JSONL lines (`AsyncBufReadExt::read_until(b'\n', ...)` into one reused buffer, never a
fixed-size byte buffer a record can be cut off mid-way through) up to
`PREVIEW_SCAN_HARD_CAP_BYTES = 64 * 1024` -- about 5x the ~11 KB observed real-world overhead,
generous headroom for OMP adding further prelude entries, while still at most 0.45% of the
14.3 MB file `docs/spike/FINDINGS.md` item 11 originally measured. Reading stops the instant the
first `role: 'user'` message is found (not merely once the cap is reached), so the common case --
a first message well inside the cap -- is cheaper than the old code's own fixed read, not just no
worse. The title read needs no separate window: OMP physically fixes it at a 256-byte slot that
is always the file's first line (`omp://session.md` "File Format"), always well inside the 64 KiB
cap regardless of where the cap lands, so the same single streaming pass reads it for free.

**Decision**: a Conversation whose cap is hit before a user message is found is still listed
(title read as above, `preview: None` turned into an empty string at the IPC boundary) rather
than hidden -- reaching the cap proves nothing about whether a user message exists further into
the file, so treating it as "no user message" would reintroduce a silent-hide bug under a
different trigger (an unusually large but genuine prelude). Only a Conversation that reaches
real end-of-file within the cap without ever finding a user message is skipped, unchanged from
the existing data-model.md rule ("files with zero user messages are not listed").

**Scope decision**: Electron's identical `src/main/conversations.ts` bug is not fixed -- the
issue's own acceptance criteria scope the fix to the Rust build only, since Electron is already
being retired (epic #797, R13).

**Gate round 1 correction (code-reviewer/test-reviewer, PR #1006, HIGH)**: the first draft read
complete lines with a plain `BufReader::read_line` over the raw file handle and only checked an
own-tracked byte counter AFTER each complete line finished, which is not actually a hard cap --
one sufficiently long single line (unrelated to this issue's own filler, but possible in
principle) could still be read in full regardless of the cap. Fixed: the file handle itself is
wrapped in `AsyncReadExt::take(PREVIEW_SCAN_HARD_CAP_BYTES)` before the `BufReader`, so not one
byte past the cap is ever read from disk by any underlying read call, whatever a single line's
own length; `read_until(b'\n', &mut buf)` reuses one buffer (`.clear()` per line) rather than
allocating a fresh `String` per line. A piece that does not end in `\n` (the `take` limit cut it
short, or the real file itself ends mid-line with no closing newline) is never parsed as a whole
record, matching the original design's own "never parse a line that was cut off mid-record" rule
exactly, just enforced at the read layer instead of after the fact. Lines (including the title
line) are parsed from raw bytes (`serde_json::from_slice`), not a lossy/validated `String`
conversion first -- invalid UTF-8 in one line simply fails to parse there, same as any other
malformed line, and is skipped rather than aborting the whole scan (no `?` operator sits between
a read and a parse anywhere in the function).

**Gate round 1 correction (code-reviewer, PR #1006, LOW)**: the first draft's "found a user
message" check additionally required non-empty extracted text (`if !text.is_empty() { preview =
Some(...) }`), so a `role: 'user'` message with no text content (image-only, or an empty/missing
`content`) left `preview` at `None` and the scan kept looking for a LATER message with non-empty
text; if none existed before the cap or real end-of-file, the Conversation was hidden -- the same
class of bug FR-086 exists to fix, reintroduced under a different trigger. Decided (Skippy,
delegated by Stuart 2026-10-18, gate round 1): any `role: 'user'` message counts as found, full
stop; `preview` becomes `Some(String::new())` when its own text is empty, and the scan never
continues past it. FR-086 and its own Clarifications entry updated to state this explicitly.

## 22. Stage rows defer running auto-open to the chain row (issue #1000, 2026-10-18; renumbered
from a provisional decision 21 once #1006 claimed decision 21 on `origin/main` first for issue
#862)

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

## 23. Stage label colour and jump-to-Stage from the chain row (issue #1008, 2026-10-18)

**Problem**: `StageGroupRow`'s own label and `ChainStageLine`'s terse per-Stage summary line
apply `SUBAGENT_SUCCESS_TEXT_CLASS` (green) to a finished Stage's label (decision 11/FR-079),
but leave a failed Stage's own label the default muted colour -- only its icon
(`SubagentStatusGlyph`) turns red. With both a finished and a failed Stage open side by side,
the finished one reads as more significant than the failed one, the opposite of what matters.
`ToolRow.tsx` already solved the identical problem for a failed tool call's own label
(`labelClassName={item.status === 'error' ? 'text-severity-error' : undefined}`, FR-061).
Separately, `ChainStageLine` renders each Stage's own name as a plain, non-interactive `<span>`
-- with ten Stages in a turn (issue #941's own fixture), finding the one the chain row's own
summary line describes means scrolling the whole transcript by hand.

**Decision** (Skippy, delegated by Stuart 2026-10-18, both items pre-decided on the issue from
a ui-architect-v3 gate finding at PR #1007/#1000): (1) a new shared
`subagentStatus.tsx#subagentStatusTextClass(status)` resolves to `SUBAGENT_SUCCESS_TEXT_CLASS`
when finished, `SUBAGENT_ERROR_TEXT_CLASS` (`text-severity-error`, the same token `ToolRow.tsx`
already uses) when failed, and `undefined` otherwise (running/cancelled/exited stay neutral) --
one call, read by both `StageGroupRow`'s own label and `ChainStageLine`'s button, so the two
surfaces can never colour a Stage differently. (2) `ChainStageLine`'s "Stage N" text becomes a
real `<button>` with the accessible name "Go to Stage N" (`jumpToStage`, split out to a new
`stageJump.ts` module to keep `SubagentChainRow.tsx` under the #806 600-line cap): it forces the
target Stage's own manual-open state through `useStageToggleStore.setManualOpen` directly --
the SAME persisted store `useStickyDisclosure` already reads for a user's own toggle (decision
19/FR-084/#991), so a jump counts as a genuine manual open, not a second, ad-hoc "opened by a
jump" flag a remount could forget -- then looks the target row up by a new, stable DOM id
(`stageRowDomId`, a new `id` prop threaded through `CollapsedLine` onto whichever element
already receives focus: the plain row `div` with no `children`, or the `CollapsibleTrigger`
button with them) and calls `scrollIntoView`/`.focus()` on it. `ChainStageLine` is a SIBLING of
the Stage row it targets, never its parent, so there is no React ref to use; the shared DOM id
is the one mechanism available that does not require threading new props down through
`Transcript.tsx`'s own render loop. No virtualizer removes the target row from the DOM
regardless of scroll position to defeat this -- `message-scroller.tsx`'s own
`content-visibility:auto` only skips paint/layout work off-screen (confirmed: this codebase has
no windowing-library virtualizer at all), so a plain `document.getElementById` lookup at click
time is synchronous and reliable; the target Stage is guaranteed already mounted, since it
renders earlier in the SAME turn as the chain row itself (decision 5: the chain row is always
appended at the very end of its own turn). `prefers-reduced-motion` drops the smooth scroll to
`'auto'`, matching `SideChatPanel.tsx`'s own existing convention.

**Live check** (`scripts/verify-1008-stage-label-jump.mjs`, modelled on
`scripts/verify-1000-stage-defer.mjs`'s harness scaffolding and
`verify-941-stage-naming-helpers.mjs`'s selectors/`resolveCssVarColor` colour-measurement
pattern): reuses the SAME `stages-941.jsonl` fixture every `verify-941-*`/`verify-991-*`/
`verify-1000-*` script already shares (AGENTS.md: no new fixtures) -- it already carries a
genuinely failed Stage (Stage 5, one `FailAgent` member) among ten Stages, so "2+ Stages where
one fails" needs no fixture change. Measures Stage 5's own label against the theme's resolved
`--severity-error` (the one red/green discriminator for item 1: reads the default/muted colour
on `origin/main`) and Stage 1's own label against the same token (a regression guard: a done
Stage must never match it). Proves the jump on two independent, never-otherwise-touched,
multi-member, fully-finished Stages (so each starts genuinely closed, FR-089's own no-bad-
member rule) -- Stage 1 by a mouse click, Stage 3 by keyboard (focus the button directly, then
a real Enter keypress, proving native `<button>` activation needs no special-casing): each
proof asserts the target row's own trigger is open (`aria-expanded="true"`), holds keyboard
focus (`document.activeElement`), and sits inside the window's own viewport
(`getBoundingClientRect`). The jump button's own existence (`button[aria-label="Go to Stage
N"]`) is itself the second red/green discriminator: `origin/main` never renders one at all
(`ChainStageLine`'s "Stage N" text stays a plain span there), so the lookup fails outright.
Screenshots in all 3 themes. **Written, not run end-to-end**: no build slot granted for this
sub-task -- `node --check` plus a real `import()` load-check (with `CARGO_TARGET_DIR` unset,
stopping at the shared build-slot guard before touching cargo) are the only commands actually
run against this file.
