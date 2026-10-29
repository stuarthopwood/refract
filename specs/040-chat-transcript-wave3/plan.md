# Plan: Chat transcript (wave 3)

Spec: `spec.md`. One PR, work packages in this order so only one worker edits `ChatPane.tsx` at a time.

1. **WP-A Rename and quick fixes** (#896 first so later work uses the new names; then #1283, #907, #1130, #1220, #473).
2. **WP-B Banners and errors** (#746 `PaneBanner` and the Button `text` variant, then #1284 Turn error row and Retry line on top of it).
3. **WP-C Transcript rows** (#1262 and shared clamp, #1041 `SourceTag`, #1210 newest-running shimmer).
4. **WP-D Tool dialog** (#719).
5. **WP-E Split focus tint** (#684, `ChatPane.tsx`, `ChatHeader.tsx`, `globals.css`, theme contrast pairs).
6. **WP-F Parked agents** (#1098: probe, Rust mapping and subscription in `src-tauri/src/session/`, then the renderer vocabulary).

Shared files touched additively: `src/renderer/components/ui/button.tsx` (text variant), `src/renderer/components/` (`PaneBanner`, `SourceTag`, shared clamp), `src/renderer/styles/globals.css` (tokens), `scripts/theme-contrast-pairs.mjs`. Not touched: `src-tauri/src/omp/process.rs`, `process_args.rs`.

Build slot: no cargo or tauri command until the director grants it. Typecheck, vitest and node scripts are fine. WP-F's Rust edits are written without building; they compile at the single slot window.
