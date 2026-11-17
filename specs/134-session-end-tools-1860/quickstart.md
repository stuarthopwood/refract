# Quickstart: live check for #1860

Build `pnpm exec tauri build --debug --no-bundle` from a clean committed tree (never `pnpm dev`), copy the exe to the scratch folder, run it with its own `--remote-debugging-port` and a scratch `REFRACT_DATA_DIR`, and drive it over CDP with the recorded-frame fake omp (`scripts/verify-tauri-fake-omp.mjs`, pattern of `scripts/verify-tauri-1858.mjs` and `verify-tauri-1859.mjs`). Script: `scripts/verify-tauri-1860.mjs`. Record head sha and `dirty: false`.

Seed: Project with Session A (the caller, ask mode), child B, grandchild C, unrelated Session D, and Personal Agent P. Calls go through the host-tool channel as A.

## Cases

1. **Self and ancestor refusal**: each of the six tools on A returns `invalid_target`; on a child launched from C, the same tools on A and B (ancestors) return `invalid_target`. No card appears.
2. **Personal Agent refusal**: each of the six on P returns `invalid_target`, no card.
3. **Unknown id**: `not_found` for each tool.
4. **Archive, no cascade**: archive B -> one card (title `Archive Session B`); approve -> only B archived, C keeps its link; deny on D -> `denied`, D live.
5. **Archive cascade**: archive B with `include_children: true` -> exactly one card listing B and C; approve -> both archived, both agents stopped, result `ids` is `[B, C]`.
6. **Yolo**: switch A to `yolo`; archive and stop D raise no card.
7. **Pause and resume, own tree**: pause B and resume B raise no card; Sessions show paused then running. Pause D (outside own tree) -> card; approve.
8. **Resume stopped**: resume a stopped Session -> `session_not_running`; resume a running unpaused one -> `invalid_state`.
9. **Stop**: stop D -> card (ask mode), approve -> stopped; stop again -> `session_not_running`.
10. **Unarchive and gate**: unarchive an archived child of a parent with 4 live children -> `child_limit`; after one is archived it succeeds; only the named Session is restored.
11. **Delete in yolo**: with A in `yolo`, delete C -> card still appears; approve -> `outcome: "deleting"` at once, the row shows deleting, then disappears; list a Session whose parent was deleted and confirm it is a root; an archived child of the deleted Session keeps its link.
12. **Delete refusal**: delete D while its worktree is held (open file) -> `delete_refused`, row unchanged.
13. **No toast**: every error returned to the agent shows no renderer toast.

## Evidence

Screenshots of the one-card cascade and the yolo delete card, call timings, `jq`-style dump of the registry before and after case 11, head sha, `dirty: false`.
