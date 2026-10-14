# Tauri security baseline (issue #793, lane R10b, epic #797)

The checklist that replaces constitution Principle V ("Electron Security Baseline") for the Rust
build -- drafted here per #793's own wording ("drafted here, adopted in #796"); #796 (the parity
gate) is what actually swaps it into the constitution and the Technology section once every lane
has landed. Each item below is the Tauri-build equivalent of one Electron-build guarantee, with
where it is enforced and how it was verified this PR.

## 1. Capabilities: the renderer gets only the commands it needs

`src-tauri/capabilities/default.json` grants `core:default` (the baseline window/app/event
permission set every Tauri window needs) plus a single **scoped** `opener:allow-open-url` entry
restricted to `https://**`/`http://**` -- narrower than the plugin's own `opener:default`/
`allow-default-urls` bundles, which also admit `mailto:`/`tel:` and the unscoped
`reveal_item_in_dir`. No other plugin grants a JS capability at all: every other plugin call in
this build (dialog's `pickFolder`, clipboard's `writeText`, and this lane's own
`shell::notifications`/`tauri_plugin_single_instance`) is Rust-side only, never invoked from the
renderer, so it needs no capability regardless of what this file grants (documented in the
file's own description). Verified by reading `capabilities/default.json` and the generated
`gen/schemas/desktop-schema.json` it validates against; `pnpm tauri build --debug --no-bundle`
compiles the capability set without a schema error.

## 2. No devtools in a release build

Tauri's own `devtools` Cargo feature ("Enabled by default on debug builds") is not listed in
`src-tauri/Cargo.toml`'s `[dependencies] tauri = { ... }` entry, so `tauri-build`'s own
profile-aware feature resolution is the sole gate: a true release build (`cargo build --release`
/ `tauri build` without `--debug`) compiles it out entirely, and no code in this build calls
`WebviewWindow::open_devtools()` anywhere (`grep -rn "open_devtools" src-tauri/src` finds
nothing). `tauri build --debug` (the harness's own build-and-copy verification method) is a
debug-PROFILE binary and does carry devtools, by design -- it is not the shipped artefact.

## 3. External-link policy: only http and https through the opener plugin

The renderer (shared, unchanged) renders ordinary `<a target="_blank">` links trusting Electron's
own `setWindowOpenHandler`/`openExternalSafe` to open them in the system browser and silently
drop anything that is not `http:`/`https:`. `src/tauri-bridge/externalLinks.ts`
(`installExternalLinkHandler`, wired from `entry.ts` before the renderer mounts) is the Tauri
equivalent: a capture-phase `click` listener that always prevents the default `target="_blank"`
action (matching Electron's own `setWindowOpenHandler`, which ALWAYS denies the native new-window
request), then calls the opener plugin's `open_url` command only when the href parses with
protocol `http:`/`https:`. The capability scope (item 1 above) is the second, independent gate:
even a bug in this handler could not escape it to `mailto:`/`tel:`/anything else, since the
command itself refuses an unscoped URL. Verified: `pnpm typecheck` passes;
`capabilities/default.json`'s scope is read, not asserted.

## 4. Navigation lock: the webview can never leave the app

`lib.rs`'s `is_allowed_navigation_url` (pre-existing, R1) restricts same-window navigation to the
app's own origin by `Url::origin()` comparison (scheme+host+port), gated on `tauri::is_dev()` (not
`cfg!(debug_assertions)`, so `tauri build --debug` is correctly treated as not-dev). `wry` denies
new windows outright (no `on_new_window` handler registered), so neither a same-window navigation
nor a popup can reach a remote origin. This lane added nothing here (R1's own scope) beyond
confirming item 3's external-link handler is the ONLY sanctioned way out of the app, and that it
goes through the system browser, never a same-window navigation.

## 5. No remote content

The window loads only the app's own bundled/dev-served HTML (`tauri/index.html`, `WebviewUrl::
App`); `frontendDist`/`devUrl` in `tauri.conf.json` are the only two origins `is_allowed_navigation_url`
(item 4) ever accepts, and both are first-party. No `<iframe>`/remote asset loading exists in
`src/renderer` (shared, unchanged; already audited for the Electron build).

## 6. Single instance

`tauri_plugin_single_instance::init` (registered first in the plugin chain, issue #793): a second
launch focuses the first window's existing session (restoring from minimised, then `set_focus()`)
and exits, never opening a second window or a second set of agent processes. No JS capability
needed (the plugin has no JavaScript API at all).

## 7. Notifications: no new attack surface

`tauri-plugin-notification` is driven entirely from Rust (`shell::notifications`): the renderer
never calls it, so (per item 1) it needs no capability grant. The one thing a notification click
can do is focus the window and emit `ui:open-session` with a Session id the backend itself chose
(round-tripped through the notification's own `extra` payload, not renderer-supplied) -- the same
trust level the existing `ui:open-session` event already carries.

## 8. Window state: no new attack surface

`shell::window_state`'s `window-state.json` lives in `crate::data_dir()` (the same pinned,
non-renderer-writable folder as `registry.json`/`settings.json`), written only by the backend
(`store::atomic_json`'s existing write-tmp-then-rename helper), never read or writable by the
renderer. A corrupt or hand-edited file degrades to the default centred window (`resolve_bounds`'s
own clamping/validation), never a crash or an off-screen/unusable window.

## Verification performed this PR

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (27 unit tests,
  including new coverage this gate round added: `is_allowed_navigation_origin` same-origin/
  wrong-port/wrong-scheme/remote-host/`file:`/`javascript:`/`data:` refusal, `visible_on`'s
  title-bar-band width/height boundaries and an off-top case, `LAST_STATUS` eviction).
- `pnpm typecheck`, `pnpm test`, `pnpm check:file-size`, `pnpm check:indent`,
  `pnpm check:theme-contrast`, `pnpm check:drag-regions`, `pnpm check:parity` (all pass).
- Read-only audit of `capabilities/default.json`, `tauri.conf.json`, and every new/changed
  `src-tauri/src/shell/*` file against the items above; no `open_devtools`/unscoped
  capability/remote-content code path found anywhere in this build.
- **Single-instance, live-checked**: built the debug exe, copied it to a scratch dir, launched
  it, then launched a second copy of the same exe. The second process exited immediately (code
  0) while the first stayed up and `ready` throughout (confirmed via its own log) -- process-
  level proof the rejection path runs and the first instance is never disturbed by it.
- **Window-state restore, NOT conclusively live-checked**: attempted over CDP (`Browser.
  setWindowBounds` to move/resize, then `Browser.close`) -- neither reached Tauri's native `tao`
  window at all: the reported bounds after `setWindowBounds` did not match what was requested,
  no `Moved`/`Resized`-triggered write appeared on disk afterward, and `Browser.close` left the
  process running. This is CDP-over-WebView2 not exposing the native window to the Browser
  domain here, not a finding about `Tracker` itself. A real mouse-driven move/close/relaunch was
  not attempted: several other lanes had their own scratch `Refract (Rust preview)` windows open
  at the same time with identical titles, and the available window-finding tool could not
  reliably single out this lane's own window by pid -- driving the wrong window by accident was
  judged too risky to try blind. Verified instead by: the 34 passing unit tests above (including
  `resolve_bounds`'s own missing/off-screen/oversized/undersized/multi-display/maximized cases),
  code review of `Tracker::on_window_event`'s `CloseRequested` arm against Tauri's own documented
  guarantee that it fires before the window is destroyed, and the debounced-save design matching
  issue #623's own "a resize or move made less than 500ms before closing is still saved"
  requirement. A real live check is a recommended follow-up once a lane has sole claim to the
  foreground (or #795's harness can target a specific scratch window unambiguously).
- Notification click-to-focus and the Tauri file-drop path were also NOT exercised against a
  real toast / a real mouse-driven OS drag (CDP-synthesized drag events do not reliably reach
  wry's native drag-drop interception point, the same class of tooling gap the R10a spike itself
  flags for a different feature) -- verified instead by unit test and by reading the plugin's own
  source for the exact API contract relied on. File drop also depends on `attachments.
  readImageFile`, which lane R4 (PR #821) implements with the Electron path-safety walk; this
  PR's own channel is the drop-to-real-OS-path wiring, not the backend read, so #823 merges
  after #821.

## Follow-ups (not this lane's scope)

- Full Action-Center-revival notification parity (native AUMID toast activation) if it turns out
  to matter in practice -- spike recommendation, tracked alongside #277/#794.
- `tauri-plugin-decoration` (frameless, themed, Snap-Layout-preserving caption) if Electron-caption
  visual parity is ever explicitly requested -- spike section 1's own recommendation, a separate
  story (new Cargo dependency, capability/CSP wiring, `activate_and_show` lifecycle, DPI/zoom test
  pass), not folded into this PR.
- Default context menus / menu-bar-hidden-until-Alt / AppUserModelId+taskbar icon are owned by R8
  (#791) and R11 (#277, #794) respectively, not this lane.
