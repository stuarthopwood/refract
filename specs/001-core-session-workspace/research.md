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
fallback tier (shared name prefix, else a bare "Stage N") -- the panel has no per-call `context`
to read the first tier from. A Stage header's own real "Uses:" dependencies (resolved the same
"latest earlier occurrence wins" way `groupSubagentStages.ts`'s `applyDependencies` already
does, against `id`/`toolCallId`/`specIndex` instead of `name`/`toolCallId`/`specIndex`) render
via the chat pane's own `StageUsesLine`, forced into its existing plain-text fallback
(`sessionId={null}`) rather than adding a second, nested interactive control inside a
`role="treeitem"` the user is already inside. A solo call's own dependency is intentionally not
shown in the panel (no header row exists there to attach one to); it stays visible in the chat.

**Decision (Skippy, delegated by Stuart 2026-10-18)**: the "Up next" Todo-phase list renders
once per TURN (not once per Stage), gated on `isLastTurn` (the same boolean `Transcript.tsx`
already computes for `TurnTotalLine`) -- `ReadoutState.todoPhases` is the agent's own CURRENT
session-scoped state, not a per-turn snapshot, so showing it after every past turn with a Stage
would repeat the identical list. Also gated on that turn having at least one Stage
(`stages.length > 0`): "below the last Stage" has no anchor point in a turn that never ran a
`task()` call at all. No separate live-vs-reopened-history check is needed in the renderer:
`compute_up_next` (`src-tauri/src/session/readout_todo.rs`) already filters to only phases with
at least one non-`completed`/`abandoned` task and returns `null` outright for a reopened
Conversation (`state_synced` gates it the same way `contextUsage` is gated) -- `todoPhases`
being non-null on the wire already means "live, and something is still pending."
