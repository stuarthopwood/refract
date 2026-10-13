# R10a shell spikes (issue #793, epic #797 lane R10)

Spikes run against the live `dev:tauri` build (Tauri v2.12.3, WebView2 Runtime
155.0.4283.45 installed on this machine) driven over CDP
(`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.dispatchDragEvent`,
`Input.dispatchKeyEvent`, `Page.captureScreenshot`) on `--remote-debugging-port
=9352`, plus doc research for the one behaviour CDP cannot exercise (a real
Windows toast click). No throwaway spike code is committed; this file is the
only artifact. No renderer or Rust code changed as a result of these spikes
(see each section's "Forced renderer edits").

## 1. Window dragging and the caption

**Question.** Does `-webkit-app-region: drag` work in WebView2, or must the
renderer move to `data-tauri-drag-region` and the window API? Can the window
be frameless with a themed caption and working Snap Layouts, or is native
decorations (and deleting the spacers) the only clean answer?

**Method.**
- Read `src-tauri/src/lib.rs`: the window is already built with
  `.decorations(true)` (native OS frame), a milestone-1 choice already
  recorded in `spec.md`'s Assumptions ("native OS window decorations... not a
  defect to fix here").
- Behavioural test: recorded `window.screenX/screenY` before/after dispatching
  a press-move-release mouse sequence over the renderer's `.drag-region`
  strip (computed style confirmed `-webkit-app-region: drag` is applied).
  Position never changed. `CSS.supports('-webkit-app-region', 'drag')`
  returns `true` (Blink's CSS parser accepts the property), but nothing
  implements it: WebView2 is stock Chromium, not Electron's patched build,
  and has no embedder-side handling of that CSS property.
- Repeated the test after adding `data-tauri-drag-region` to the same element
  and hooking `window.__TAURI_INTERNALS__.invoke` to log every call. No
  window movement, and **no invoke call was logged at all** — Tauri/wry's
  drag detection for this attribute is implemented natively (wry inspects the
  attribute before the event reaches the DOM/JS layer), so a CDP-synthetic
  mouse event is inconclusive for this path specifically: it may not reach
  wry's native interception point the way a real hardware event does. This is
  a known tooling gap, not a finding about the attribute itself.
- Confirmed the renderer-forced gap the epic context table predicted ("the
  renderer's caption spacers leave a visible gap") does **not** actually
  happen today: both spacer formulas (`PanelTabBar.tsx`'s inline style and
  `WindowControlsSpacerRow.tsx`'s `WINDOW_CONTROLS_SPACER_STYLE`) are
  `calc(100vw - env(titlebar-area-width, 100vw))`-shaped. `env(titlebar-area-
  width)` is an Electron-only CSS environment variable set via
  `titleBarOverlay`; Tauri/WebView2 never defines it, so the fallback
  (`100vw`) always wins and the calc resolves to `0px`. Verified live via
  `getComputedStyle` on both spacer elements: `width: "0px"` for each.
- Researched the one documented, maintained third-party option for a
  themed/frameless Windows caption with working Snap Layout:
  [`tauri-plugin-decoration`](https://github.com/oovz/tauri-plugin-decoration)
  (crates.io, v3.0.5, requires Tauri 2.10+, which this build already is).
  Its README states Windows 11 gets "HTML controls with a native Snap Layout
  hit target" (Supported), Windows 10 gets HTML controls (Supported). It
  needs: a new Cargo dependency, `decorations: true` + `visible: false` +
  `titleBarStyle: "Overlay"` + `hiddenTitle: true` in `tauri.conf.json`, CSP
  additions for its embedded style asset, `decoration:default` +
  `core:window:allow-start-dragging` + `core:window:allow-internal-toggle-
  maximize` capability permissions, an `activate_and_show` Rust command
  invoked after the frontend mounts (keeps the window hidden until custom
  decoration succeeds or native decorations are restored as a fallback), and
  its own titlebar markup. It also documents a real testing burden ("test...
  at every DPI and zoom level you support").

**Result.**
- `-webkit-app-region` is confirmed non-functional in this build (behaviourally
  inert, matches upstream Tauri guidance that it is Electron-only).
- The predicted visible-gap defect does not reproduce: both spacer sites
  already collapse to `0px` under Tauri today. `spec.md`'s Assumptions
  entries (lines 44-46, 348-351) describing a "visible gap" should be
  corrected to "verified `0px`, no gap" the next time that spec is touched;
  not changed here since spec.md is not this lane's file.
- A real frameless/themed/Snap-Layout-preserving option exists
  (`tauri-plugin-decoration`), but it is a third-party crate with a
  non-trivial activation/CSP/permission footprint and its own DPI/zoom test
  matrix — this is squarely "work after the spikes" scope, not a spike-sized
  change.

**Recommendation for R10b.** Keep `.decorations(true)` (already the code
today) for milestone 1; it already renders correctly with no visible gap, at
zero additional dependency risk, while the overnight/no-review window is
open. Treat `tauri-plugin-decoration` as the follow-up candidate if/when
Electron-caption visual parity is explicitly requested — scope it as its own
story (new Cargo dependency, capability/CSP wiring, `activate_and_show`
lifecycle, DPI/zoom test pass), not folded into R10b silently. Native
decorations' `data-tauri-drag-region`/`-webkit-app-region` CSS the renderer
still carries is harmless dead weight under native decorations (window
already drags via the OS title bar); leave it in place rather than editing
`check-drag-regions.mjs`'s contract without R12a/#795 coordination, which the
issue explicitly calls out.

**Forced renderer edits.** None. The spacer already resolves to `0px`; no
code change needed to close the predicted gap.

## 2. File drop (dropping an image into the composer)

**Question.** Does dropping an image into the composer (#432, #514) reach the
renderer, or does Tauri's own file-drop handler swallow the HTML5 drop event
first?

**Method.** Wrote `window`-level capture-phase listeners for `dragenter`,
`dragover`, `drop`, then used CDP's `Input.dispatchDragEvent` to simulate a
real OS-level file drag over the app (first with a non-existent path, then
with a real 76-byte PNG written to `C:/Users/shopwood/test.png`, to rule out
Blink silently discarding a drop whose file handle doesn't resolve).

**Result.** `dragenter`/`dragover` reached the DOM every time; `drop` never
did, with a real file backing the drag in both runs. This matches Tauri's own
tracked behaviour
([tauri-apps/tauri#14373](https://github.com/tauri-apps/tauri/issues/14373)):
`dragDropEnabled` (window config key, not currently set here, so the default
`true` applies) means Tauri's native drag-drop handler owns the drop and the
page's own HTML5 `drop` event never fires. Confirms the issue's concern
exactly: the native handler swallows it.
`src/tauri-bridge/index.ts` already documents the matching, narrower gap for
*after* a drop lands: `getPathForFile()` is a stub that throws
("Dropping files is not available in the Rust build yet."), because the
standard `File` API never exposes an OS path the way Electron's `webUtils.
getPathForFile` does — so even disabling `dragDropEnabled` to restore the
HTML5 path would still dead-end at that stub today.

**Recommendation for R10b.** Don't disable `dragDropEnabled`; instead listen
to Tauri's own `onDragDropEvent` (`@tauri-apps/api/webview`,
`getCurrentWebview().onDragDropEvent(...)`), which delivers real absolute OS
paths (`{ paths: string[], position: {x, y} }`) directly — strictly better
than `webUtils.getPathForFile`, no `File`-object workaround needed. Hit-test
`position` against the composer's `getBoundingClientRect()` to decide whether
the drop landed on the attach target, then feed the resulting absolute path
into the already-implemented `ATTACHMENTS_READ_IMAGE_FILE` channel, whose
doc comment (`src/shared/ipc.ts` line ~533) already accepts "an absolute OS
path ... or a path relative to this Session's own worktree" — no backend
change needed, only the renderer's drop-detection source. Retire the
`getPathForFile` stub-that-throws for the Tauri build once this lands.

**Forced renderer edits.** Real, but not small: a new `onDragDropEvent`
listener plus composer hit-testing in `ChatPane.tsx`/`tauri-bridge/index.ts`.
Left to R10b; not implemented here.

## 3. Clipboard image paste

**Question.** Does `clipboardData.items` with an image, plus
`createImageBitmap`, behave as in Electron's Chromium?

**Method.** Set the real Windows clipboard to a 4x4 bitmap via PowerShell
(`System.Windows.Forms.Clipboard.SetImage`), focused the composer textarea in
the live app (an actual running session, `scratch-repo`/`rustic-tern`), and
dispatched a real `Ctrl+V` key sequence via CDP (`Input.dispatchKeyEvent`,
not a synthetic JS `dispatchEvent`). Captured the resulting `paste` event's
`clipboardData.items`, then independently ran `createImageBitmap` on the
`getAsFile()` result to validate the full decode pipeline.

**Result.** Full pass, twice over:
- Raw platform check: `clipboardData.items` reported `{ kind: "file", type:
  "image/png" }`; `createImageBitmap` on the resulting file decoded a 4x4
  bitmap matching the source image exactly (`file.size` 104 bytes, type
  `image/png`).
- Real app code path: the same paste, run against the live composer, produced
  two pending image-attachment thumbnails in the UI (confirmed by
  screenshot) — `MessageInput.tsx`'s existing `handlePaste` /
  `findClipboardImageItem` / `reencodeToPng` pipeline (`attachments.ts`) works
  unmodified in WebView2, exactly as in Electron. This is plain web-platform
  clipboard-paste behaviour (unrelated to Tauri's `clipboard-manager` plugin,
  which only covers programmatic reads/writes, not the `paste` keyboard
  event), so there was never Tauri-specific interception to find here.

**Recommendation for R10b.** No work needed; this is parity today.

**Forced renderer edits.** None.

## 4. Notification click-to-focus

**Question.** On Windows, can a click on a notification focus the window and
carry the Session id, or does it need a native toast with activation
(windows-rs)?

**Method.** No `tauri-plugin-notification` dependency exists yet in
`Cargo.toml`/`capabilities` (confirmed by reading both), so there is nothing
to drive live, and a real Windows toast click cannot be exercised over CDP or
`computer` (the task's own constraint: `computer` clicks are refused while
Stuart's Electron Refract owns the foreground). Spike is doc-grounded only,
against the official crate
([`tauri-plugin-notification` v2 docs.rs source](https://docs.rs/tauri-plugin-notification/2.6.0/src/tauri_plugin_notification/desktop.rs.html),
[README](https://github.com/tauri-apps/tauri-plugin-notification/blob/v2/README.md)).

**Result.** The crate's own doc comments on `NotificationBuilder`/`on_action`
state plainly: "A click on the notification itself ('tap') or on one of its
actions. Notifications shown before the first handler or listener existed
report nothing." and, platform-specific: **"Windows: a click is only
reported while the toast is on screen, not once it moved to the Action
Center."** So:
- A click on a visible toast **can** carry data back to the app (the
  builder's `.data(...)`/JS payload round-trips through `ActionPerformed`,
  so a Session id embedded there is available to the handler) and the app's
  handler is Rust/JS code the app writes itself — it must explicitly call
  `window.show()` + `window.set_focus()` and emit the `ui:open-session`-
  equivalent event; the plugin does not do this automatically.
- This genuinely does **not** need a native windows-rs AUMID toast activator
  for the common case (user clicks while the toast is still visible) — that
  native path (reviving the app from the Action Center with launch args,
  matching Electron's own full AUMID-based activation) would only be needed
  to close the Action-Center gap, and is real native Windows platform work,
  not a spike-sized addition.

**Recommendation for R10b.** Add `tauri-plugin-notification` (Cargo +
`notification:default` capability), send the needs-you/finished notification
with the Session id in its data payload, and implement `on_action` (Rust) or
`onAction` (JS) to call `set_focus()` + emit the existing `ui:open-session`
event. Accept the Windows "toast must still be visible" limitation for
milestone 1 (matches Electron closely enough for the acceptance criteria
as written: "a needs-you notification, clicked, brings the Session to the
front"); track full Action-Center-revival parity (native AUMID activation) as
a separate follow-up only if it turns out to matter in practice, alongside
the already-planned AppUserModelId/taskbar-icon work (#277, #794).

**Forced renderer edits.** None yet; this is new feature wiring (Cargo +
Rust + a small JS listener), left to R10b.

## 5. WebView2 feature audit

**Question.** Does the WebView2 runtime support what the renderer's CSS/JS
already uses: `content-visibility`, container queries, `color-mix`, `oklch`,
scrollbar styling, `::highlight()` (planned for #753), `text-wrap`, fonts;
and what WebView2 runtime version is installed?

**Method.** `CSS.supports(...)` for each feature plus `CSS.highlights`/`:has()`
/`popover` checks, run live via CDP `Runtime.evaluate` against the actual
renderer page. Cross-checked the installed WebView2 Evergreen Runtime version
via the registry (`HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-
FE2A-4295-8BDF-00C3A9A7E4C5}`, value `pv`).

**Result.** All supported, no gaps found:

| Feature | Supported |
|---|---|
| `content-visibility` | yes |
| Container queries (`container-type`) | yes |
| `color-mix()` | yes |
| `oklch()` | yes |
| `scrollbar-color` | yes |
| `scrollbar-width` | yes |
| `text-wrap: balance` | yes |
| `CSS.highlights`/`::highlight()` | yes |
| `:has()` | yes |
| `popover` attribute | yes |

Installed WebView2 Runtime: **155.0.4283.45** (matches this build's live
`navigator.userAgent`: `Chrome/155.0.0.0 Edg/155.0.0.0`) — a materially newer
Chromium than Electron 44's bundled Chromium, so every CSS/JS feature the
renderer already relies on is covered with headroom.

**Recommendation for R10b.** No CSS/JS feature gaps to work around; nothing
to change in `src/renderer`/`src/shared` for WebView2 compatibility.

**Forced renderer edits.** None.

## Shared infrastructure note (not a shell spike, logged for the record)

While starting `dev:tauri`, the shared `CARGO_TARGET_DIR` (`C:/Users/shopwood
/.cargo-target/refract`) had a corrupted cached build-script output for the
`tauri` crate (hash `tauri-01b4edc673bdda09`): its cached `output` file
embedded absolute paths from the old `C:/Repos/personal/pinion-worktrees/
rust-tauri/src-tauri/target` worktree, breaking every build that needs
`tauri`'s generated permission files. Removed the two stale cache entries
(`build/tauri-01b4edc673bdda09`, `.fingerprint/tauri-01b4edc673bdda09`) —
equivalent in effect to `cargo clean -p tauri`, scoped to that one crate only
— and the dev build compiled clean immediately after. Broadcast to peers at
the time; other lanes hit the same symptom under different hashes (one per
worktree's exact dependency/feature set) and resolved theirs the same way
(`cargo clean -p <crate>`) per Main's guidance.
