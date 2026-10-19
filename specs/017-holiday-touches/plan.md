# Implementation Plan: Holiday touches

**Branch**: `feat/1048-holiday-touches` | **Issue**: #1048 | **Spec**: `spec.md`

## Summary

A pure holiday-calendar module (`shared/holidays.ts`) feeds a themed-icon content table
(`renderer/features/holidays/holidayContent.ts`) into five existing render paths (the chat
watermark, the start-message pool, the sidebar logo, two empty states, and the agent-working
spinner), all gated by a new three-way `Settings.holidayTouches` field (Full/Artwork only/Off)
added end-to-end alongside the existing `watermarkEnabled` field. A sixth, new placement -- the
ambient loop -- is a decorative layer mounted in the same background slot `BrandWatermark.tsx`'s
`'live'` variant already uses, with its own JS-driven pause rules (window hidden/unfocused, 60s
idle) layered on top of CSS-only OS-reduced-motion/forced-colors handling. A debug-only IPC
channel (`debug.getOverrides`) lets a live check override "today" and shorten the idle pause,
inert in every release build.

## Technical Context

**Language/Version**: TypeScript (renderer, shared) / Rust 2021 (`src-tauri`), matching the rest
of this codebase -- no new language, no new dependency (`lucide-react` is already a dependency;
no new npm/cargo package added).
**Storage**: `settings.json` (one new field, no migration).
**Testing**: none added (AGENTS.md prototyping rule, "no new tests") -- existing Rust unit tests
for `SettingsStore`/the new `debug.rs` module's pure parsing helpers cover the one genuinely new
pure-logic surface (env var parsing); everything else is verified live
(`scripts/verify-1048-holiday-touches.mjs`).
**Target Platform**: Windows 11, Tauri/Rust build only (the Electron build is frozen, epic #797 --
this feature has no Electron counterpart, the same posture `wordPredictionEnabled` already set).
**Project Type**: existing Tauri + React/Vite app; no new project structure beyond one new
renderer feature folder (`renderer/features/holidays/`) and two new Rust modules
(`store/holiday_touches.rs`, `ipc/debug.rs`).

## Constitution Check

- **I. OMP Is the Engine**: not touched -- this feature has no OMP/session/RPC surface at all.
  PASS.
- **II. RPC Wire Contract**: not touched. PASS.
- **III. Session and Process Lifecycle**: not touched. PASS.
- **IV. Evidence Before Design**: N/A (no OMP-dependent behaviour). PASS.
- **V. Tauri Security Baseline**: the new `debug.getOverrides` channel is registered on the SAME
  existing `refract_request` dispatcher every other channel already uses (no new Tauri command, no
  new capability grant); it never reads from the filesystem or network, only two environment
  variables, gated `#[cfg(debug_assertions)]` so a release build's capability surface is
  unchanged. PASS.

No new or expanded capability, no new window, no new native command -- `Gate: PASS`.

## Project Structure

```
src/shared/
  holidays.ts              # NEW: pure calendar (HolidayId, HOLIDAY_WINDOWS, activeHoliday)
  holidayTouches.ts         # NEW: HolidayTouches type
  model.ts                  # Settings.holidayTouches field added
  ipc.ts                    # SETTINGS_SET_HOLIDAY_TOUCHES / DEBUG_GET_OVERRIDES + RefractApi additions

src/renderer/
  features/holidays/
    holidayContent.ts       # NEW: HOLIDAY_CONTENT table (icon/emoji/lines per holiday)
    HolidayAmbientLoop.tsx  # NEW: the ambient loop component + pause-rule effect
  features/chat/BrandWatermark.tsx    # holiday watermark variant
  features/chat/ChatPane.tsx          # mounts HolidayAmbientLoop; empty-state line; start-message pool merge
  features/sessions/SessionList.tsx   # sidebar accessory
  features/profile/ManageSessionsScreen.tsx  # "No sessions yet" holiday line
  features/settings/AppearanceSection.tsx    # the Holiday touches Select control
  components/brand/AgentSpinner.tsx   # holiday spinner glyph swap
  state/holiday-store.ts    # NEW: useHolidayStore (resolved date override, idle timeout, activeHoliday)
  state/settings-store.ts   # holidayTouches default + setHolidayTouches action
  state/init-stores.ts       # bootstraps initHolidayOverrides()
  styles/globals.css         # ambient loop CSS, holiday spinner CSS

src/tauri-bridge/index.ts    # settings.setHolidayTouches, debug.getOverrides

src-tauri/src/
  store/holiday_touches.rs   # NEW: HolidayTouches enum
  store/settings.rs          # Settings.holiday_touches field, open()/serialize_for_disk/setter
  ipc/settings.rs            # settings.setHolidayTouches handler
  ipc/debug.rs               # NEW: debug.getOverrides handler + pure env-parsing tests
  ipc/mod.rs                 # module registration

scripts/verify-1048-holiday-touches.mjs  # NEW: the live check
```

## Phased approach (mirrors `tasks.md`)

1. **Framework**: the pure calendar, the `HolidayTouches` type/enum end-to-end (Rust store + IPC
   + shared TS + renderer store/setting), the debug override channel, the renderer's
   `useHolidayStore`.
2. **Halloween, all five placements**: watermark, start messages, sidebar, both empty states,
   spinner glyph.
3. **Halloween ambient loop**: the bats, the pause-rule effect, the CSS.
4. **Settings UI**: the Appearance section control.
5. **Live verification**: `scripts/verify-1048-holiday-touches.mjs`, five-preset screenshots, CPU
   measurement.
6. *(Follow-up, tracked in PLAN.md, not this PR unless budget allows)*: Bonfire Night, Christmas,
   New Year, Star Wars Day, Pi Day content and the three remaining ambient loop effects.
