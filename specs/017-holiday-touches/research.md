# Research: Holiday touches

## Grill decisions (Stuart, 2026-10-19, `/grill-with-docs`, #1048) -- verbatim, all resolved

1. **Where**: the chat watermark, the start messages, the sidebar logo, empty states, and the
   agent-working spinner.
2. **Motion**: static artwork, plus ambient loops in season (for example falling snow, flickering
   pumpkins, firework sparks). This amends `docs/design/foundations-motion.md:9` ("Motion always
   carries a function, never only decoration") with a named "Holiday touches" exception.
3. **Control (WCAG 2.2.2)**: Settings > Appearance gets "Holiday touches" with three choices --
   Full (artwork and ambient loops, the default), Artwork only (no loops), and Off. Ambient loops
   also stop when the window is hidden or unfocused, after 60s with no input, and under OS
   reduced motion.
4. **Holidays and windows** (local date): Halloween 24-31 Oct, Bonfire Night 1-5 Nov, Christmas
   1-26 Dec, New Year 31 Dec-1 Jan, Star Wars Day 4 May, Pi Day 14 Mar.
5. **Colour and meaning**: holidays never change theme colours, state colours or text. Artwork
   uses the active theme's own accent and muted tokens. The holiday spinner keeps the spinner's
   colour, size, speed, sr-only "Working" word and reduced-motion static glyph; only its shape
   changes.
6. **Priority**: p2, aiming for the framework plus Halloween before 24 Oct, with the other
   holidays before 1 Nov.

## Decisions made while implementing (not deferred, not grilled separately -- recorded here per
`grill-with-docs` convention for anything the issue itself left as "for example"/"proposal")

- **Icon per holiday, reused across the watermark/sidebar/spinner** (not three different assets):
  the issue's own "Technical notes" names `Ghost`/`Snowflake`/`TreePine`/`PartyPopper`/`Sparkles`/
  `Pi` as available lucide glyphs and separately proposes "small hand-made single-colour SVGs" for
  the watermark/logo variants. Rendering the SAME lucide icon directly (a themed React element,
  coloured via `--muted-foreground`/`--agent-spinner-core`) at all three icon-shaped placements is
  simpler than hand-drawing six more SVG assets to `mask-image`, carries the same "single-colour,
  theme-token" property lucide icons already have, and avoids a second asset pipeline. Final
  per-holiday icon choice: Halloween `Ghost`, Bonfire Night `Flame`, Christmas `TreePine`, New
  Year `PartyPopper`, Star Wars Day `Swords`, Pi Day `Pi` -- every name checked against the
  installed `lucide-react` 1.49.0 (`node -e "console.log(typeof require('lucide-react').Ghost)"`,
  all six print `object`).
- **Ambient loop effect, Halloween**: "gentle pumpkin flicker or drifting bats (pick the calmer
  one)" -- drifting bats chosen: a slow positional/opacity drift reads as calmer than a flicker,
  and a flicker would need its own tuning to stay clear of the WCAG 2.3.1 three-flashes-a-second
  ceiling, where a slow drift simply never approaches it.
- **Ambient loop effects for Bonfire Night/Christmas/New Year**: named by the issue
  ("sparks"/"snow"/"sparks") but not yet built in this PR -- tracked as this issue's own follow-up
  (PLAN.md), per the issue's own "Build the framework plus Halloween completely first... then add
  the other holidays if budget allows" framing. The framework (calendar, setting, debug override,
  `HolidayContent.hasAmbientLoop` gate) already covers all six holidays; only the per-holiday
  loop markup and the watermark/start-message/empty-state copy for the other five remain.
- **Star Wars Day / Pi Day have no ambient loop**: the issue's own "Ambient loops" section names
  an effect for exactly four holidays (Halloween, Christmas, Bonfire Night, New Year); it never
  names one for Star Wars Day or Pi Day. Treated as static-artwork-only by design, not an
  oversight -- `HolidayContent.hasAmbientLoop: false` for both.
- **Debug override mechanism**: an environment variable read only in a debug build
  (`#[cfg(debug_assertions)]`), exposed to the renderer over a new `debug.getOverrides` IPC
  channel -- the exact posture `lib.rs::data_dir`'s pre-existing `REFRACT_DATA_DIR` override
  already uses, including the "inert in release even if the variable happens to be set" property.
  A renderer-only dev flag (`import.meta.env.DEV`) was considered and rejected: the live-check
  convention's own build (`tauri build --debug --no-bundle`) runs `vite build` for the frontend
  bundle regardless of the Rust profile, so `import.meta.env.DEV` is `false` in exactly the debug
  exe a live check copies and launches -- a renderer-only flag would never fire in that build.
- **"No Sessions" empty state**: read as `ManageSessionsScreen.tsx`'s own "No sessions yet" block
  (the Manage sessions screen's empty state), kept distinct from `ChatPane.tsx`'s "No Session
  selected" ("empty chat pane") -- both are named separately in the issue's own "Empty states (no
  Sessions, empty chat pane)" parenthetical, and both are real, separate `Empty` blocks in the
  code today.
- **Settings control widget**: a three-option `Select` (Radix, already vendored in
  `components/ui/select.tsx`), not a radiogroup -- `ChatWidthPicker`/`ThemePicker`'s own
  hand-rolled radiogroup exists specifically for their Save/Cancel preview-then-commit flow
  (`research.md` decisions elsewhere); Holiday touches applies live with no preview step, the same
  posture the watermark `Switch` already has, so a plain controlled `Select` is the simpler fit.

## Alternatives considered and rejected

- **Six new hand-drawn SVG assets** for the watermark mask (one per holiday), matching spec 012's
  own `mask-image` technique exactly: rejected in favour of a direct themed icon render (see
  above) -- same visual contract (single colour, theme token, faint, `aria-hidden`), far less
  asset-pipeline work, and no new build step.
- **A renderer-side `setInterval` re-checking the active holiday every minute**: rejected --
  `activeHoliday` is resolved once at startup (a day boundary crossing mid-session is not a case
  the issue asks for, and the app's own typical session length makes it moot); the one-shot
  bootstrap load mirrors every other initial-load in `init-stores.ts`.
