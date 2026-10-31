# Plan 109

Hand-authored Spec Kit artefacts (specify, clarify via the issue's decision comment, plan, tasks, analyze). Route: specify.

- `AppearanceSection.tsx`: `SettingSwitchRow`, `allowHoliday={false}` on the preview, a `Separator` above Decoration.
- `globals.css`: drop the `--watermark-opacity` copies that equal the `:root` default (Dark, Cyber Amber); keep the overrides contrast needs (Obsidian, High contrast, Nordic Frost).
- `scripts/check-theme-contrast.mjs`: `themeWatermarkOpacity(themeId)` reads the theme block first.
- Header chips: class-level truncation per the ui-architect-v3 ruling.
- Live check: the existing `scripts/verify-406-watermark.mjs`, plus a Tab pass, an accessibility-tree check, a 620px chip check and a holiday-date preview check; `report.json` records `gitHead`.
