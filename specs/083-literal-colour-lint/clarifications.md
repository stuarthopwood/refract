# Clarifications: spec 083

### Session 2026-10-31 (self-grill, Skippy delegated by Stuart; recorded on #1473)

- Q: Components only, or all renderer code? [Decided] All non-test `.ts`/`.tsx` under `src/renderer`; class strings live in shared maps too.
- Q: Which literals fail? [Decided] Hex and palette classes. `rgb()`/`hsl()` stay out until slice 6 (one gradient in `ColorPicker`).
- Q: Replace the remaining hex literals? [Decided: no] None has a neutral token swap (canvas probe, parse sentinel, picker default, Mermaid fallback owned by #1474); baseline them.
- Q: Palette cleanup? [Decided] Already done by spec 081; zero lines at HEAD.
- Q: UI review? [Decided: not needed] No renderer colour changes.
- Q: Tests? [Decided: none] Prototyping rule; the script is a gate.
