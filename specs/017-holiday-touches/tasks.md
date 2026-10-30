# Tasks: Holiday touches

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/ipc.md`

## Phase 1: Framework

- [X] T001 Pure holiday calendar (`src/shared/holidays.ts`): `HolidayId`, `HOLIDAY_WINDOWS` (all
      six, decision 4), `activeHoliday(date)` with the shorter-window-wins overlap rule.
- [X] T002 `HolidayTouches` type (`src/shared/holidayTouches.ts`) and Rust enum
      (`src-tauri/src/store/holiday_touches.rs`), kebab-case on both sides.
- [X] T003 `Settings.holiday_touches` end-to-end: Rust store field + `open()` lazy-default +
      `KNOWN_FIELDS` + `serialize_for_disk` + `set_holiday_touches` (`store/settings.rs`); IPC
      handler + registration (`ipc/settings.rs`); shared TS `Settings.holidayTouches` field
      (`shared/model.ts`); `IPC_REQUESTS`/`RefractApi.settings.setHolidayTouches`
      (`shared/ipc.ts`); bridge method (`tauri-bridge/index.ts`); renderer store default + action
      (`renderer/state/settings-store.ts`).
- [X] T004 Debug-only overrides: `debug.getOverrides` Rust handler
      (`src-tauri/src/ipc/debug.rs`, `#[cfg(debug_assertions)]`-gated env var reads, pure-parsing
      unit tests), registered in `ipc/mod.rs`; `IPC_REQUESTS.DEBUG_GET_OVERRIDES` +
      `RefractApi.debug.getOverrides` (`shared/ipc.ts`); bridge method
      (`tauri-bridge/index.ts`).
- [X] T005 `useHolidayStore` (`renderer/state/holiday-store.ts`): resolves the override date (or
      real system date) once at startup via `initHolidayOverrides()`, caches `activeHoliday`/
      `idleTimeoutMs`; wired into `init-stores.ts`'s bootstrap sequence and `state/index.ts`'s
      exports (including the dev-only `window.__refractStores` table).

## Phase 2: Halloween content and placements

- [X] T006 `HOLIDAY_CONTENT` table (`renderer/features/holidays/holidayContent.ts`): icon, emoji,
      start-message lines, empty-state line, `hasAmbientLoop` for all six holidays (Halloween
      content fully authored; the other five carry real but not-yet-live-verified content, see
      Phase 6).
- [X] T007 Chat watermark holiday variant (`features/chat/BrandWatermark.tsx`): renders the active
      holiday's icon in place of the plain mark, same opacity/size/anchor/`aria-hidden` contract;
      CSS forced-colors/reduced-transparency suppression extended to the new class
      (`styles/globals.css`).
- [X] T008 Start-message pool extension: `pickStartingMessageIndex` generalised to take an
      explicit pool length (`features/chat/startingMessages.ts`); `ChatPane.tsx` builds the
      combined pool (base + holiday lines/emoji) via `useMemo` and picks/reads from it.
- [X] T009 Sidebar logo accessory (`features/sessions/SessionList.tsx`): holiday icon beside the
      "Refract" wordmark, `aria-hidden`, accessible name unchanged.
- [X] T010 Empty-state lines: `ChatPane.tsx`'s "No Session selected" and
      `ManageSessionsScreen.tsx`'s "No sessions yet", both `aria-hidden`, both alongside (never
      replacing) the existing `EmptyDescription`.
- [X] T011 Agent-working spinner glyph swap (`components/brand/AgentSpinner.tsx`): holiday icon
      in place of the default core, same `--agent-spinner-core` colour token, same
      `CYCLE_MS`/phase-locked delay, `.agent-spinner-holiday` CSS (`styles/globals.css`) with its
      own `prefers-reduced-motion`/forced-colors rules.

## Phase 3: Halloween ambient loop

- [X] T012 `HolidayAmbientLoop.tsx` (`renderer/features/holidays/`): renders only for
      `holidayTouches === 'full'` and `HOLIDAY_CONTENT[holiday].hasAmbientLoop`; Halloween renders
      three drifting bat silhouettes.
- [X] T013 Pause-rule effect: window hidden/unfocused and 60s-idle (using
      `useHolidayStore`'s `idleTimeoutMs`) both drive a `data-paused` attribute; OS reduced motion
      and forced-colors are plain `@media` rules needing no JS (`styles/globals.css`).
- [X] T014 Mounted in both of `ChatPane.tsx`'s `BrandWatermark variant="live"` spots (the
      `!session` empty branch and the live transcript container), gated by the same
      `showWatermark` prop -- painting behind normal-flow content by construction satisfies "never
      over text/controls" and "never under the composer" with no new z-index/pointer-events
      bookkeeping.

## Phase 4: Settings UI

- [X] T015 "Holiday touches" `Select` control in `features/settings/AppearanceSection.tsx`, next
      to the watermark switch, applying live (no Save/Cancel), `aria-describedby` hint text
      matching the watermark control's own pattern.

## Phase 5: Live verification

- [ ] T016 `scripts/verify-1048-holiday-touches.mjs`: builds the debug exe, launches it with
      `REFRACT_DATE_OVERRIDE` inside the Halloween window, asserts all five placements in all
      five theme presets (screenshots), asserts Full/Artwork only/Off behaviour, asserts the loop
      stops on blur/hide/reduced-motion/idle (idle shortened via `REFRACT_HOLIDAY_IDLE_MS`),
      asserts the spinner's sr-only "Working" word (AX tree) and its reduced-motion glyph,
      asserts a no-override baseline shows no holiday artwork, measures idle CPU
      Full-on-vs-Off, and writes `report.json`.

## Phase 6: Remaining holidays (slice 2, FR-013a)

- [ ] T017 Switch Bonfire Night, Christmas, New Year, Star Wars Day, Pi Day on
      (`VERIFIED_HOLIDAYS`) and live-verify their `HOLIDAY_CONTENT` entries (T006) across the
      placements on faked dates, incl. the 31 Dec / 1 Jan boundary, Artwork only/Off, reduced motion.
- [ ] T018 Bonfire Night (sparks), Christmas (snow), New Year (confetti) ambient loops in
      `HolidayAmbientLoop.tsx` + a new `holidayArtwork.tsx` (inline SVG, per-holiday flight keyframes).
