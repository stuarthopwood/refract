# Parity: `IPC_REQUESTS` / `IPC_EVENTS` / theme bootstrap vs. the Rust build

The parity table used to be hand-kept here. It drifted: by 2026-10-13 it still said "todo" on
all 107 rows although 24 request channels and the milestone-1 events were already implemented
(`src-tauri/src/ipc/mod.rs`, `src-tauri/src/events.rs`). Issue #784 replaced it with a generated
report instead of a second hand-edit pass every time a lane lands a channel.

## Generate the table

```
pnpm check:parity              # plain-text table + totals
pnpm check:parity -- --markdown  # the same table as GitHub-flavoured markdown
```

`scripts/check-parity.mjs` reads `IPC_REQUESTS`, `IPC_EVENTS` and `THEME_BOOTSTRAP_CHANNEL`
straight from `src/shared/ipc.ts` (never copied), scans `src/main` for the Electron source file
that registers or sends each channel, scans `src-tauri/src` recursively for the matching Rust
`register(...)` call or emitted event, and looks up the owning Phase R lane from a map derived
from `docs/PLAN.md`'s "Phase R: Rust promotion" table. Because every column is re-derived from
source on every run:

- A channel added to `ipc.ts` later shows up as missing automatically -- there is no table to
  remember to update.
- The report does not depend on which `.rs` file a channel's `register(...)` call currently
  lives in, so splitting `ipc/mod.rs` into per-lane modules (this issue, #785-#792) never breaks
  the count.
- A lane's own `pnpm check:parity` run after landing a channel is the live check every Phase R
  row's "Verification" section asks for (docs/PLAN.md "Verification for every lane"): confirm
  the lane's channels list as implemented and none still returns `unsupported`.

## The gate

`pnpm check:parity -- --gate` exits 1 if any request, event, or the theme bootstrap is not yet
implemented; plain `pnpm check:parity` always exits 0 (report-only). The parity gate (issue #796,
docs/PLAN.md row R13) turns `--gate` on once the cutover -- 86 of 86 requests and 20 of 20 events
-- is ready; until then this script is read-only information for lanes and reviewers, not a CI
failure.

## Lane ownership

The channel-to-lane map lives in `scripts/check-parity.mjs` next to the scan logic (search for
`REQUEST_LANES`/`EVENT_LANES`), not here, so it never falls out of sync with the generator. It
is derived from docs/PLAN.md's "Phase R: Rust promotion" table (the `Files touched` column) and
updated in the same change whenever a Phase R row's files move.
