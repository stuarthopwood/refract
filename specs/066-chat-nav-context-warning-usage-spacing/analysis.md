# Analysis: spec 066

- Every FR maps to a task: FR-1 to T1, FR-2 to T2 and T3, FR-3 to T4, FR-4 to T5, FR-5 to T6, FR-6 to T7.
- No conflict with ADR 0003 (shared components extended by prop or variant) or ADR 0005 (one message index; the index is untouched).
- Risk: `scrollPreviousItemPeek` also feeds the library's snapshot. Verified in `@shadcn/react` 0.3.1 that the peek is read only for the observer margin and the snapshot, so `0` widens the visible window and changes nothing else. Check live.
- Risk: a catalog that omits `contextWindow` yields null and no warning, which is the safe direction.
- No new tests (prototyping rule); verification is `ci:local` and the live checks.
