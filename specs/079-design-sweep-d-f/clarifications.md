## Clarifications (delegated decisions, ui-architect-v3 ruling, 2026-10-31)

Decision comments: #1466 (issuecomment-6536658596), #1467 (issuecomment-6536658942), #1468 (issuecomment-6536659220).

- ColorPicker presets are round single-colour radios; themes keep the two-colour, never-round `ThemeSwatchChip`.
- Theme radio items are exempt from the leading icon (radio ring is the leading mark).
- `Install GitHub CLI` gets `DownloadIcon` and an sr-only "Opens in your browser".
- `PanelHeader` is a component; the non-title 40 px rows share a height constant only.
- Sizing utilities (`h-9`, `min-h-11`) are not gated by `check:spacing`.
- `size-6`/`p-1` around a 16 px icon is 24 px and passes `check:hit-targets`.
