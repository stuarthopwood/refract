# Analysis: Chat navigation (wave 4)

Every FR-001 to FR-006 maps to tasks T1 to T12. No uncovered requirement. Risks:
- `Transcript.tsx` (baseline 1059, now 990) and `ChatHeader.tsx` are collision files; the plan serialises WP-A to WP-E and requires extraction rather than growth.
- Row ids may not equal message ids once mid-turn prose is grouped; T1 probes this before T2 fixes the index shape.
- `content-visibility` rows have estimated heights, so map marks and jumps settle late; the landing loop covers jumps, the map is approximate by design (ADR 0005).
- Custom Highlight API on WebView2 is inferred; T8 probes, and the fallback is list-and-jump without paint.
- Ctrl+F must not leak outside chat panes; verified in the live check.
