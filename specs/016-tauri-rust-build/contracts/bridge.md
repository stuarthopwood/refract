# Contract: `refract_request` (Tauri IPC bridge)

Mirrors `src/shared/ipc.ts`'s own contract for the Electron build (FR-006 to FR-011). The renderer
(`src/renderer`) is unmodified and never knows which backend it is talking to; everything in this
document is implemented on either side of `src/tauri-bridge/`.

## The one command

```text
refract_request(channel: String, args: Vec<serde_json::Value>) -> serde_json::Value
```

Registered once in `src-tauri/src/lib.rs` via
`tauri::generate_handler![ipc::refract_request]`. There is no second Tauri command and no
per-channel command; `ipc/mod.rs` owns a single dispatch table keyed by the exact string values
already defined in `IPC_REQUESTS` (`src/shared/ipc.ts`), and the returned `serde_json::Value` is
always shaped as the `Result<T>` envelope that type already defines:

```ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: IpcError };
```

In Rust, each handler returns a `RefractResult<T: Serialize>` (a thin Rust-side mirror of the same
two-variant shape) that `refract_request` serializes to `serde_json::Value` before returning it
across the IPC boundary; the TS side never needs to know the Rust-internal type, only that the JSON
on the wire matches `Result<T>` field-for-field (`ok`, and either `value` or `error: { code,
message }`).

`src/tauri-bridge/index.ts` calls this exactly once per `RefractApi` method, via
`@tauri-apps/api`'s `invoke`:

```ts
function request<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return invoke<Result<T>>('refract_request', { channel, args });
}
```

This is the same shape as `src/preload/index.ts`'s own `request<T>` helper (that file's `function
request<T>`), so every `RefractApi` method in `src/tauri-bridge/index.ts` is a one-line,
method-for-method mirror of its `src/preload/index.ts` counterpart: same channel constant, same
argument order, same return type. `parity.md` enumerates every channel this applies to.

## The `unsupported` fallback

A channel not yet ported in Rust (anything outside the milestone-1 set in `parity.md`) MUST return
(FR-007):

```json
{
  "ok": false,
  "error": {
    "code": "unsupported",
    "message": "Not available in the Rust build yet: <channel>"
  }
}
```

`<channel>` is the exact channel string the caller passed (for example
`pullRequests.submitReview`), substituted verbatim -- never a generic message, so a developer
hitting an unported path from the live UI can tell immediately which channel is missing. `code:
'unsupported'` is the `IpcErrorCode` that already exists in `src/shared/ipc.ts`'s `IpcErrorCode`
union (not modified by this feature; it is reused, not redefined). In `ipc/mod.rs`, this is the
dispatch table's `match` default arm -- never an error, panic, or hang; the one-command design
means "channel not found in the match" and "channel not yet implemented" are the same case, so
there is exactly one place this fallback is written, not 63 individually-missing registrations.

## Events

Rust emits Tauri events under exactly the `IPC_EVENTS` string values (for example
`transcript:patch`, `session:status`), with the same JSON payload shape the Electron build's
matching `window.webContents.send(IPC_EVENTS.X, payload)` call sends (FR-008). `src-tauri/src/
events.rs` defines one typed emit helper per milestone-1 event (backed by `app_handle.emit(name,
payload)` against the main window), using the literal `IPC_EVENTS` string as the event name --
never a renamed or namespaced variant.

`src/tauri-bridge/index.ts`'s `on<T>` helper mirrors `src/preload/index.ts`'s own `on<T>` (built on
`ipcRenderer.on`/`removeListener`): it wraps `@tauri-apps/api`'s `listen<T>(channel, handler)`,
returning the same `Unsubscribe = () => void` shape by calling the `UnlistenFn` `listen` resolves
to. Every `onX` method on `RefractApi` (`onSessionStatus`, `onTranscriptPatch`, ...) is backed by
exactly one `listen` call on the matching `IPC_EVENTS` string, same as the Electron bridge is
backed by exactly one `ipcRenderer.on` per event. `parity.md` lists the milestone-1 subset (8 of
20); any `onX` method whose event is not yet emitted by Rust simply never fires its handler (no
error -- the Electron contract already allows a subscriber to outlive the last time its event was
sent).

## Theme bootstrap (synchronous, not an IPC round trip)

Before creating the main window, the Rust backend reads the persisted theme from `settings.json`
(same store, same shape as `src/shared/model.ts`'s `Settings['theme']`) and injects it via a
`WebviewWindowBuilder::new(...).initialization_script(...)` call that runs before any page script,
setting:

```js
window.__REFRACT_THEME_BOOTSTRAP__ = { theme: "<id>" };
```

This is the exact object shape `src/main/ipc/theme.ts`'s `ipcMain.on(THEME_BOOTSTRAP_CHANNEL, ...)`
handler returns via `event.returnValue` for the Electron build's own synchronous
`ipcRenderer.sendSync(THEME_BOOTSTRAP_CHANNEL)` (FR-010). `src/tauri-bridge/index.ts`'s
`themeBootstrap()` reads `window.__REFRACT_THEME_BOOTSTRAP__` synchronously, with **no** `invoke`
call and no `await` (FR-011) -- matching `src/preload/index.ts`'s own `themeBootstrap: () =>
ipcRenderer.sendSync(...)`, so `src/renderer/main.tsx`'s very first line
(`initThemeStore(window.refract.themeBootstrap().theme)`) still runs synchronously before React
mounts and never paints the wrong theme for even one frame, regardless of backend.

`theme:bootstrap` (the `THEME_BOOTSTRAP_CHANNEL` string constant) is listed in `parity.md` as a
third row kind (`bootstrap`), alongside `request` and `event`, since it is neither: it is a
one-time synchronous read with no Tauri `invoke`/`listen` round trip at all on either backend.

## Content Security Policy

The Tauri entry (`tauri/index.html`) extends the existing renderer CSP
(`src/renderer/index.html`'s `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:`) with the two origins Tauri's own IPC transport requires:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost
```

`connect-src ipc: http://ipc.localhost` is required because `@tauri-apps/api`'s `invoke`/`listen`
transport goes over Tauri's own custom `ipc:` protocol and, on Windows specifically, a
`http://ipc.localhost` origin WebView2 uses for the same channel; every other directive is
unchanged from the Electron renderer's CSP, since `src/renderer` itself is not modified (FR-016).

## Security model (Tauri v2 equivalent of constitution Principle V)

Principle V is written in Electron-specific terms (`contextIsolation`, `nodeIntegration`,
`contextBridge`) and is formally suspended for this build (plan.md Constitution Check), but the
equivalent protections are not absent, just differently shaped:

- No Node integration in the Tauri webview by construction (Tauri's webview is never given a
  Node.js runtime at all, unlike Electron where `nodeIntegration: false` is a configurable flag).
- `capabilities/default.json` is an explicit allowlist of exactly the Tauri plugin permissions this
  build needs (`shell-open` for external links, `dialog` for the repository folder picker,
  `clipboard-write`, filesystem access scoped to Session worktrees) -- the Tauri v2 analogue of
  Electron's `webPreferences.sandbox: true` plus this app's own `will-navigate`/`setWindowOpen
  Handler` guards in `src/main/index.ts`.
- `invoke`-only IPC: the renderer has no way to reach an arbitrary Rust function, only the single
  allowlisted `refract_request` command, same shape of guarantee `contextBridge.exposeInMainWorld
  ('refract', refract)` gives the Electron build (the renderer never sees a raw `ipcRenderer`/
  `invoke` surface, only the typed `window.refract` object `src/tauri-bridge/entry.ts` assigns
  before importing `src/renderer/main.tsx`).
