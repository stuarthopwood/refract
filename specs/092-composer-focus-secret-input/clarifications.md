# Clarifications (spec 092)

Decided (Skippy, delegated by Stuart 2026-10-31):

1. Fallback focus is the stop banner's first enabled button, else the banner itself; never `<body>`.
2. On re-enable, focus returns to the textarea only from the banner or body.
3. One helper and one call site per transition; `stopAndRestore` focuses once.
4. The Dark (high contrast) outline is measured against 3:1 and fixed through the theme token only on failure; it passed, so no change.
5. Extend shared components: `SecretInput` composes `Input` and `IconButton`; no one-off control.
6. The answered state reads "Secret entered", muted, never the value or its length.
7. Rust parses `secret`; the response value is never logged, persisted or echoed.
8. Live check uses the fake omp with a `secret:true` frame; real OMP 18.13.2 is not required.
9. Masked field: autocomplete off, spellcheck off, no paste blocking.
