# Data Model: Holiday touches

## `HolidayId` (`src/shared/holidays.ts`)

```ts
type HolidayId = 'halloween' | 'bonfire-night' | 'christmas' | 'new-year' | 'star-wars-day' | 'pi-day'
```

Not persisted; derived fresh from `activeHoliday(date)` every time it is needed (once per app
run, cached in `useHolidayStore`).

## `HolidayTouches` (`src/shared/holidayTouches.ts`, Rust: `src-tauri/src/store/holiday_touches.rs`)

```ts
type HolidayTouches = 'full' | 'artwork' | 'off'
```

Persisted in `Settings.holidayTouches` (`settings.json`, default `'full'`), mirrored by the Rust
`HolidayTouches` enum (`#[serde(rename_all = "kebab-case")]`, so the two serialise identically).
No raw/lazy-correction tracking (unlike `theme`/`watermarkEnabled`/`showSampleData`) -- a missing
or malformed on-disk value resets to the default, the same posture `chatWidth` already has.

## `HolidayWindow` (`src/shared/holidays.ts`, module-private)

```ts
interface HolidayWindow {
  id: HolidayId
  name: string
  start: { month: number; day: number } // 1-12, 1-31
  end: { month: number; day: number }
}
```

Six literal entries (decision 4). `New Year`'s `start` (31 Dec) sorts later in the calendar year
than its `end` (1 Jan) -- the one wrapping window; every other window's `start` precedes its own
`end` within the same year.

## `HolidayContent` (`src/renderer/features/holidays/holidayContent.ts`, renderer-only)

```ts
interface HolidayContent {
  id: HolidayId
  name: string
  icon: LucideIcon               // reused across the watermark, sidebar accessory, and spinner
  emoji: string                  // leading glyph for start-message additions
  startingMessages: readonly string[]
  emptyStateLine: string         // decorative only, aria-hidden
  hasAmbientLoop: boolean        // gates HolidayAmbientLoop.tsx entirely
}
```

One entry per `HolidayId`, in `HOLIDAY_CONTENT: Record<HolidayId, HolidayContent>`. Not imported
by `shared/holidays.ts` (that module stays pure, no `lucide-react` dependency) or by Rust (purely
a renderer presentation concern).

## `Settings.holidayTouches` (added field)

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `holidayTouches` | `HolidayTouches` | `'full'` | Persisted, applies live, no migration needed (a pre-#1048 `settings.json` simply lacks the key). |

## Debug overrides (not persisted; env-var-sourced, debug builds only)

```ts
interface DebugOverrides {
  date: string | null          // REFRACT_DATE_OVERRIDE, 'YYYY-MM-DD'
  idleTimeoutMs: number | null // REFRACT_HOLIDAY_IDLE_MS
}
```

Read once via `window.refract.debug.getOverrides()` at startup (`init-stores.ts`), cached in
`useHolidayStore` (`dateOverride`, `idleTimeoutMs`). A release build's Rust handler always answers
`{ date: null, idleTimeoutMs: null }` regardless of the real process environment
(`#[cfg(debug_assertions)]` gates every env var read, matching `lib.rs::data_dir`'s own
`REFRACT_DATA_DIR`/`REFRACT_IMPORT_SOURCE_DIR` posture).
