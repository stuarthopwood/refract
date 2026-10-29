# Analysis: Chat transcript (wave 3)

Every FR-001 to FR-014 maps to a task T1 to T15. No uncovered requirement. Risks:
- `ChatPane.tsx` is touched by T3, T5, T7, T8 and T13; the plan serialises them.
- #1284's TLS hint wording assumes #1287 (separate PR); the hint text does not depend on it landing.
- #1098's wire string is unprobed; T14 gates T15's Rust mapping, and the fallback is vocabulary only.
- File-size baselines: `ChatPane.tsx` and `MessageInput.tsx` may only shrink.
