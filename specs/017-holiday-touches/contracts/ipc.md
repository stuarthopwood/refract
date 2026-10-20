# Contract: `settings.*` and `debug.*` additions (Holiday touches, #1048)

## `settings.setHolidayTouches(value: 'full' | 'artwork' | 'off')`

- **Request**: one positional string argument, one of `'full' | 'artwork' | 'off'`.
- **Response**: `Result<Settings>` -- the whole persisted row, same shape and race-safety pattern
  as `settings.setChatWidth`/`settings.setWatermarkEnabled`. Persists the whole row and broadcasts
  `settings:changed`, exactly like every other `settings.set*` channel.
- **Errors**: `invalid-argument` for anything other than the three known strings (missing
  argument, wrong type, or an unrecognised value).
- **Side effects**: none beyond the persisted row and the broadcast -- no Session is started,
  stopped, or restarted by this call (unlike `settings.setApprovalMode`'s own pending-mode
  bookkeeping).

## `debug.getOverrides()`

- **Request**: no arguments.
- **Response**: `Result<{ date: string | null; idleTimeoutMs: number | null }>`.
  - `date`: the debug build's `REFRACT_DATE_OVERRIDE` environment variable (`YYYY-MM-DD`), or
    `null` if unset, blank, or the build is a release build.
  - `idleTimeoutMs`: the debug build's `REFRACT_HOLIDAY_IDLE_MS` environment variable, parsed as
    an unsigned integer, or `null` if unset, unparsable, or the build is a release build.
- **Errors**: none -- this channel never fails; an unset/invalid override is simply `null`, never
  an error envelope.
- **Availability**: registered in every build (never conditionally absent from the dispatcher), so
  calling it never returns `unsupported` -- only its own ANSWER differs between debug and release.
  This matters for the renderer bootstrap: it can call this channel unconditionally, with no
  feature-detection round trip, and treat a release build's always-inert reply exactly like "no
  override was ever set" (the same code path a debug build takes with both variables unset).

## `Settings.holidayTouches`

Added to the `settings.get` / `settings:changed` payload's existing `Settings` shape:

```json
{
  "...": "...",
  "holidayTouches": "full"
}
```

No version bump, no migration: a pre-#1048 `settings.json` simply lacks this key, and
`SettingsStore::open` defaults a missing or malformed value to `HolidayTouches::Full` exactly like
`ChatWidth`'s own lazy-correction.
