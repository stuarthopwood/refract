# Constitution amendment draft: Tauri security baseline and stack (DRAFT)

**Status**: DRAFT. Written by lane R1 (issue #784, epic #797) so other lanes can cite it while
building; the amendment itself is a separate decision, issue #796 (the parity gate), which also
ratifies it with a version bump per the Governance section's rule ("MINOR for a new principle or
section or materially expanded guidance"). Nothing in this file is in force until #796 lands it
through `/speckit.constitution`.

## What this replaces

`.specify/memory/constitution.md`, as of version 2.0.0 (2026-10-11):

### Principle V, "Electron Security Baseline" (current text, to be replaced)

> - Every `BrowserWindow` MUST set `contextIsolation: true`, `nodeIntegration: false`, and
>   `sandbox: true`.
> - Only the main process spawns processes or touches the file system and git. The renderer
>   reaches them through a typed, allowlisted API exposed from the preload with `contextBridge`.
> - Agent, tool, and file output is untrusted. The renderer MUST NOT inject it as raw HTML, and
>   markdown MUST be rendered through a sanitiser.
> - App windows MUST NOT load remote content. External links open in the system browser.

### "Platform and Stack" section (current text, to be replaced in part)

> - Windows 11 is the only supported and tested OS for v1. OS-specific process control lives in
>   one main-process module so other platforms can be added later.
> - Electron main and preload processes plus a Vite + React renderer, all in TypeScript with
>   `strict: true`.
> - OMP runs as a child process over stdio, so the app needs no Bun. No extension ships with the
>   app (the earlier side-chat extension, `docs/spike/btw-ext.ts`, was never shipped and is
>   superseded by the native `btw` RPC, amended 2026-10-11, spec 014; see Principle II).

Only the second bullet (the Electron-specific process model) is false now; the first and third
bullets (Windows 11 only, no Bun/no shipped extension) stay true unchanged for the Tauri build and
are not touched by this draft.

## Proposed replacement text

### Principle V, "Tauri Security Baseline" (draft)

> - Every window MUST ship with a minimal `capabilities/*.json` grant: no capability the renderer
>   does not use (`src-tauri/capabilities/default.json`). Rust-side plugin calls the renderer never
>   invokes directly (for example `repositories.pickFolder`'s `app.dialog()`,
>   `clipboard.writeText`'s `app.clipboard()`) need no capability entry regardless, because they
>   are reached only through the one validated command below, never through a webview-exposed
>   plugin API.
> - `tauri.conf.json`'s `app.security.csp` MUST stay a restrictive allowlist (`default-src 'self'`,
>   no inline/remote script, `connect-src` limited to the app's own IPC origin) -- the Tauri
>   equivalent of Principle V's old sandbox/context-isolation guarantee, enforced by the WebView2
>   content-security policy instead of Electron's process model.
> - Same-window navigation MUST be restricted to the app's own origin (dev server in a dev build,
>   the app's own custom-protocol origin in a release build), checked by scheme+host+port, not
>   substring or prefix match (`src-tauri/src/lib.rs`'s `is_allowed_navigation_url`) -- the Tauri
>   equivalent of Electron's `denyForeignNavigation`.
> - App windows MUST NOT load remote content. External links open in the system browser
>   (unchanged from the current Principle V bullet; `opener:allow-open-url`/
>   `opener:allow-default-urls` in `capabilities/default.json`).
> - The renderer MUST reach the Rust backend through exactly one validated command,
>   `refract_request(channel, args)` (`src-tauri/src/lib.rs`). It dispatches only to the string
>   channel names already defined in `src/shared/ipc.ts`'s `IPC_REQUESTS`/`IPC_EVENTS`; there is no
>   second command surface and no direct filesystem/process/git access exposed to the webview --
>   the Tauri equivalent of the old preload `contextBridge` allowlist.
> - Agent, tool, and file output is untrusted. The renderer MUST NOT inject it as raw HTML, and
>   markdown MUST be rendered through a sanitiser (unchanged from the current Principle V bullet;
>   this is a renderer-side rule and applies identically to both shells).
> - Every `omp` child process (and its descendants) MUST be contained by a kill-on-close Job
>   Object joined before any `omp` spawn (`src-tauri/src/process/job_object.rs`,
>   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), so a killed or crashed Refract process cannot leave a
>   live `omp` tree behind -- the Tauri equivalent of the Electron build's `koffi`-based Job Object
>   (`src/main/process/jobObject.ts`), now native `windows-rs` bindings.

### "Platform and Stack" (draft replacement for the second bullet only)

> - Windows 11 is the only supported and tested OS for v1. OS-specific process control lives in
>   one module (`src-tauri/src/process/`) so other platforms can be added later. *(unchanged)*
> - A Tauri v2 Rust backend (`src-tauri/`) plus a Vite + React renderer, all in TypeScript with
>   `strict: true` on the renderer side and Rust `edition = "2021"` on the backend side. The
>   renderer is reused unchanged from the Electron build; the backend replaces Electron's main and
>   preload processes.
> - OMP runs as a child process over stdio, so the app needs no Bun. No extension ships with the
>   app (the earlier side-chat extension, `docs/spike/btw-ext.ts`, was never shipped and is
>   superseded by the native `btw` RPC, amended 2026-10-11, spec 014; see Principle II).
>   *(unchanged)*

## Notes for #796

- This draft only replaces the Electron-specific clauses that promotion makes literally false; it
  does not touch Principles I-IV, which the Constitution Check table in
  `specs/016-tauri-rust-build/plan.md` already records as "Applies, unchanged" for the Tauri build.
- The parity gate (#796) also decides whether Electron is deleted outright (`docs/PLAN.md` Phase R
  intro: "Electron is deleted at the parity gate") -- if so, every "unchanged, same as the Electron
  build" cross-reference above and elsewhere in the constitution needs a second pass to drop the
  comparison entirely, which is out of scope for this draft.
- Cite this draft, not the current ratified text, when a Phase R lane needs a security-baseline
  reference; the ratified text until #796 lands remains the Electron-specific Principle V above.
