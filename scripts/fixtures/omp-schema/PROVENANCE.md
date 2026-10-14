# Provenance: vendored OMP RPC wire schema

These two files are vendored verbatim (no edits) from the published npm package, pinned to the
exact version cross-checked against the installed `omp` CLI at the time of pinning:

- **Package**: `@oh-my-pi/pi-coding-agent@18.10.1`
- **Fetched with**: `npm pack @oh-my-pi/pi-coding-agent@18.10.1 --silent`, extracted to a scratch
  temp directory, and copied out verbatim:
  - `package/src/modes/rpc/wire/rpc-wire.schema.json` -> `rpc-wire.schema.json`
  - `package/src/modes/rpc/wire/rpc-wire.generated.ts` -> `rpc-wire.generated.ts`
- **Date pinned**: 2026-10-14
- **Cross-checked against installed `omp` CLI version**: `omp/18.10.1` (`omp --version`), i.e. the
  pinned schema package version matches the installed CLI version exactly at pin time.

## Keeping this pin current

Run `node scripts/check-omp-schema-drift.mjs --check-pin` to compare this pinned version against
whatever `@oh-my-pi/pi-coding-agent` currently publishes on the npm registry. That check is
informational only (exits 0 regardless) -- re-vendor these two files and update this document by
hand when it reports the pin is behind.

## Scope note (issue #519 / #795 part 4)

Full codegen of `src/shared/frames.ts` or new Rust wire structs directly from this schema is
explicitly out of scope for this slice: `frames.ts`/`model.ts`/`ipc.ts` are the single most shared
files in the repo and churning them here would collide with in-flight lane work (notably R3,
issue #786, PR #827, which is actively editing `session/agent` and `ipc/mod.rs` against the
current hand-written shapes). This vendored pin + `scripts/check-omp-schema-drift.mjs` is the safe
subset: it proves schema drift is detectable without touching any shared file.
