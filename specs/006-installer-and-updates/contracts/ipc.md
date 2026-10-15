# Contract: renderer to main (typed IPC) — additions for Installer and updates

This spec adds to the one shared contract described in full by
[specs/001-core-session-workspace/contracts/ipc.md](../001-core-session-workspace/contracts/ipc.md)
(same `Result<T>` envelope, same `window.refract` surface, same rule: the renderer never touches
processes, the file system, or git directly). Only the **new** channels this spec introduces are
listed here; spec 001's own contract file is not edited by this spec.

## New error codes (added to `IpcErrorCode`, `src/shared/ipc.ts`)

| Code | Meaning |
|---|---|
| `dependency-install-failed` | A Git/OMP/GitHub CLI Install action's vendor installer exited non-zero, or the download of its own installer failed; `readiness.installDependency` awaits the whole install and returns this (the same failure also appears on the last `readiness:install-progress` event, for the progress UI). |
| `update-unavailable` | `updates.install()` called while no update is `available` (FR-012's "available" phase). |
| `checksum-mismatch` | A downloaded update installer's SHA-256 did not match its published checksum asset (FR-014); `updates.install()` awaits the whole download and returns this. |

A failed install-on-quit (FR-018) has no corresponding request to attach an `IpcErrorCode` to —
it happens at the next app start, not from a renderer call — so it is reported purely through
`UpdateState.phase: 'failed'` / `lastError` (data-model.md), read via `updates.getState()` or the
`updates:state-changed` event, never as an `IpcError`.

## Requests

### Readiness (extends spec 001's `readiness.*`, FR-005 to FR-011)

| Method | Returns | Errors |
|---|---|---|
| `readiness.check()` | `Readiness` (data-model.md: now `{ git, omp, ompSignedIn, github }`) | unchanged from spec 001 |
| `readiness.installDependency(dependency)` | `void` | `dependency: 'git' \| 'omp' \| 'github-cli'`. Starts the vendor's own official installer in the background (research.md decision 6) and awaits the whole install before resolving, so the renderer can show a spinner from one `await`; progress also arrives incrementally on `readiness:install-progress` for the Install button's own progress text. On success, main re-runs `readiness.check()` and emits `readiness:changed` itself (the caller does not need to poll). Errors: `dependency-install-failed` (FR-010: the checklist item still offers Install afterwards; this error never leaves the checklist in a stuck state). |

### Updates (FR-012 to FR-019, FR-026, FR-027)

| Method | Returns | Errors |
|---|---|---|
| `updates.check()` | `UpdateState` (data-model.md) | Never errors; an unreachable GitHub CLI resolves to `phase: 'idle'` with `unavailableReason` set (FR-017), not an IPC error, so the renderer never shows an error toast for this case. |
| `updates.getState()` | `UpdateState` | The latest known state, for the renderer to render on mount without forcing a fresh network check. |
| `updates.install()` | `void` | Awaits the whole download and checksum verification (FR-014) for the release named by the current `available` state before resolving; `updates:state-changed` also fires `'downloading'` then `'downloaded'`/`'failed'` for a progress indicator. Errors: `update-unavailable`, `checksum-mismatch`. |
| `app.getVersion()` | `string` | The running build's own version (`app.getVersion()`), for the badge and for comparing against a release's `version`. |

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `readiness:install-progress` | `DependencyInstallProgress` (data-model.md) | Drives the Install button's progress and outcome text on the first-run screen. |
| `readiness:changed` | `Readiness` | Pushed after `readiness.installDependency` finishes its automatic re-check, so the renderer does not need to call `readiness.check()` itself to pick up the result. |
| `updates:state-changed` | `UpdateState` | Drives the badge in `StatusBar.tsx` (research.md decision 11) and, later, spec 004's Settings entry and spec 008's profile-menu entry, all against this same event and the `updates.*` requests above. |

## Startup behaviour (FR-020, SC-010)

The startup update check (`updates.check()`) is kicked off after the window is shown and the
renderer's own first paint has happened, exactly like the existing low-memory sampler
(`src/main/memory.ts`) runs on its own timer rather than blocking `createWindow()`: it MUST NOT be
awaited before `BrowserWindow.show()` in `src/main/index.ts`.

## Dependency-install downloads and update downloads (constitution V)

Every HTTPS fetch this spec performs happens in the main process only, to a fixed, hard-coded set
of hosts; none of it is ever fetched by, or exposed as a URL to, the renderer:

- `api.github.com`: Git for Windows' and the GitHub CLI's own `releases/latest` metadata
  (`dependencyInstall.ts`).
- `github.com` release-asset URLs, which redirect once to `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com` -- `dependencyInstall.ts`'s `fetchFromAllowedHost`
  checks every hop's own host against this fixed pair, rather than letting `fetch` follow a
  redirect to an unchecked host (quality-gate remediation, Medium).
- `raw.githubusercontent.com`, pinned to a specific tag/commit (`OMP_PINNED_TAG`,
  `dependencyInstall.ts`), for OMP's own install script -- quality-gate remediation (Medium,
  security): the previous `omp.sh/install.ps1` redirect pointed at that upstream repository's
  moving `main` branch, which a compromised or force-pushed branch could change with no change on
  Refract's side at all.
- Whatever `gh`'s own download implementation uses for a private repository (the installer and
  checksum assets via `gh release download` in decision 3).

Release notes (`notesUrl`) only ever open through the existing safe `shell.openExternal` path
(`src/main/index.ts`'s `openExternalSafe`), never inside an app window.

