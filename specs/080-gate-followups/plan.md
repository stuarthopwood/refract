# Plan: spec 080

Four workstreams on disjoint files, then one shared-control pass, then verification.

- A: alarm clock and chain card (#1463): `AlarmClock.tsx`, chain header, `shell/alarms.rs`, two verify scripts.
- B: transcript menus and copy feedback (#1469): `ToolRowMenu.tsx`, `CodeBlock.tsx`, `MessageMenu`, `ReviewDialog`, `ContextShakeMenu`, `image_save.rs`, `docs/design/components.md`.
- C: profile Rust hardening (#1477): `profile.rs`, `handlers.rs`, gh login flow.
- D: shared-control extensions (#1477 UI): `ScreenSection`, `InlineStatus`, `Button`, `FilterTabs`, `ManageAccountsDialog` split, `ExternalLink`. Runs after B because both touch `InlineStatus`.
- E: `scripts/verify-tauri-008.mjs` tightening and `scripts/verify-tauri-080.mjs`.
- Then `pnpm ci:local` (needs the build slot), live check, six-reviewer gate.
