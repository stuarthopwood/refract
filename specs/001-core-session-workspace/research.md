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
| Markdown (untrusted) | `react-markdown` + `rehype-sanitize` | 10.1.0, 6.0.0 |
| Code highlighting | `shiki` with the JavaScript regex engine | 4.4.3 |
| File-edit diffs | `react-diff-view` | 3.3.3 |
| Long transcripts | `react-virtuoso` | 4.18.16 |
| Resizable panes | `react-resizable-panels` | 4.14.1 |
| Styling | Tailwind CSS v4 with CSS custom properties for theme | 4.3.3 |
| Component library | `shadcn/ui`, components copied into `src/renderer/components/ui/` | CLI 4.21.0 |

**Rationale**: `rehype-sanitize` is the maintained sanitiser for react-markdown, which constitution V requires because agent text is untrusted. `react-virtuoso` measures variable-height rows and has built-in stick-to-bottom, which fits 30+ tool rows and streaming text. `react-diff-view` is a React component that reads unified diffs. `isomorphic-git` was rejected: it has no `worktree` command (sourced: isomorphic-git.org command index).

**Component library (decided 2026-09-30)**: shadcn/ui. Themeable through semantic CSS-variable tokens (`--primary`, `--muted`, `--border`, and so on, with dark mode by overriding them under `.dark`), and new tokens such as `--warning` are added the documented way (sourced: ui.shadcn.com/docs/theming), which is how Pinion adds its state-colour roles. Extensible because the component source is copied into the repository, so extending a component is editing it. It has about 60 components, including Message, Message Scroller, Bubble, Marker, Kbd, Command (the Ctrl+K palette), Sidebar, Resizable, Menubar, Context Menu, Empty, Dialog, Alert Dialog, and Toast (sourced: ui.shadcn.com/docs/components). Rejected: Web Awesome 3.14.0 (web components; Combobox, Data Grid, Date Picker, and charts are Pro-only, and shadow DOM fights a Tailwind-token approach), Tamagui 2.7.7 (React Native plus web; its value is not needed for an Electron-only app; only its introduction page was read), Radix Themes 3.3.0 (prop-based theming, least extensible, last published January 2026), Fluent UI v9 and Mantine (own styling systems, would replace the Tailwind decision). Not verified: whether shadcn's Message Scroller virtualises long transcripts, and that its Resizable wraps `react-resizable-panels` [INFERENCE]; T025 tries Message Scroller before falling back to `react-virtuoso`.

**Not verified**: the zustand-versus-alternatives and virtuoso-versus-TanStack comparisons are reasoning, not measurement [INFERENCE]. The Shiki JS engine is chosen to avoid WASM loading under a sandboxed renderer; it was not benchmarked. Tailwind v4 dark-mode wiring was not fetched; the first UI task checks it before the theme system is built on it.

## 3. Conversation storage and the session directory

**Decision**: Pinion passes no `--session-dir`. Each Session's agent runs with `cwd = worktreePath`, and OMP's default per-cwd directory holds that Session's Conversations. Pinion learns the directory once from `dirname(get_state.sessionFile)` and stores it as `Session.sessionDir`.

**Rationale (verified, FINDINGS item 11)**: two worktrees of one repository get different directories; `--resume <file>` and `open_session {sessionDir}` both restore history when the cwd matches; a bare relaunch continues nothing; a Conversation's created time is in its file name.

**Consequence**: Pinion's registry stores only repository path, worktree path, name, and two pointers into OMP's data. It never parses session files beyond the first line and the first 8 KB for a title and preview.

## 4. Killing the whole agent tree when Pinion dies

**Decision**: at app start, before spawning anything, the main process creates one Windows Job Object with `KILL_ON_JOB_CLOSE` (through `koffi`) and assigns itself to it (`AssignProcessToJobObject(job, GetCurrentProcess())`). Every `omp` and every process it starts inherits membership at creation, so there is no assignment race. Also keep `processes.json` (pid plus start time) and reap matching processes at start as a fallback if job creation failed.

**Rationale (verified)**: FINDINGS item 10 proved a tool subprocess survives a force-killed parent. FINDINGS item 12 proved the self-join job killed the whole omp tree (19 to 20 descendants including the tool's `ping.exe`) within 1 s with zero escapees, also when Pinion itself was started inside another job (nested jobs), and inside Electron's main process. The alternative, assigning each `omp` pid after `spawn`, worked at 38 to 53 ms but let a pre-existing child (a conhost) escape in 2 of 3 runs, so it is not race-free. `koffi` installed as a prebuilt binary, no compile.

**Alternatives**: start-up reaping alone (cannot find tool subprocesses); a suspended-launch helper (would close the race completely, not built; revisit only if a run shows descendants at assignment time).

**Not verified**: that `koffi` loads inside Electron's main process (proven under plain Node). The first task checks it; if it fails, the fallback is `@electron/rebuild` or a Node child helper process that owns the job, which is decided then.

## 5. Protocol framing

**Decision**: negotiate protocol v2 and implement chunk reassembly in Pinion (`src/main/omp/frames.ts`).

**Rationale**: `get_messages` and `get_state` responses can exceed the 1 MiB v1 frame cap (`get_state` carries the system prompt and every tool schema). OMP's `RpcFrameDecoder` is raw TypeScript in an npm package that needs Bun (FINDINGS C22b), so the app cannot import it. The probe scripts already contain a working reassembler to copy.

## 6. Pinion's own storage

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

**Decision**: restart the Session's agent with the new `--approval-mode` and `--resume` at `session_settled` (constitution I; FINDINGS item 9). OMP has no runtime command for this (sourced: `rpc.md`, read, not probed).

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

## Unknowns that remain, and where they are resolved

| Unknown | Resolved by |
|---|---|
| How OMP reports the change made by an `edit` tool call (diff source) | First chat task: read a real `tool_execution_end.result.details` |
| How to detect "OMP signed in" reliably | First readiness task: probe `get_available_models` on a fresh process; if it lists models without login, use another signal |
| `koffi` inside Electron main | First process task (decision 4) |
| Sandboxed preload output from electron-vite | First scaffold task (decision 1) |
| Cold start on an idle machine | Not needed for the build; re-measure when convenient |
| Free-memory threshold | Tune during use |
