# Clarifications: spec 084

### Session 2026-10-31 (self-grill, Skippy delegated by Stuart; recorded on #1474, comment 6538344281)

- Q: Derive from semantic tokens or add Mermaid tokens? [Decided] New `--mermaid-*` tokens carrying today's hex, so built-ins stay pixel-equivalent and the #388 contrast tuning is preserved.
- Q: One token per Mermaid variable? [Decided] No; roles equal in every built-in share a token (text, line, palette N, ink).
- Q: Dark (high contrast) Shiki? [Decided] Keep the bundled theme unless the custom theme overrides a syntax token, then `css-variables`.
- Q: Scrollbars? [Decided] Already tokens; live proof only.
- Q: Native overlay? [Decided] Skipped: no Tauri consumer.
- Q: Re-render when only token values change? [Decided] Yes, keyed on the custom theme's token map.
- Q: UI changes? [Decided] None, so no ui-architect ruling.
