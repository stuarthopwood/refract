# Provenance: vendored OMP RPC wire schema

`rpc-wire.schema.json` is vendored verbatim (no edits) from the published npm package, pinned to
the exact version cross-checked against the installed `omp` CLI at the time of pinning:

- **Package**: `@oh-my-pi/pi-coding-agent@18.10.1`
- **Fetched with**: `npm pack @oh-my-pi/pi-coding-agent@18.10.1 --silent`, extracted to a scratch
  temp directory, and copied out verbatim:
  - `package/src/modes/rpc/wire/rpc-wire.schema.json` -> `rpc-wire.schema.json`
  - `package/LICENSE` -> `LICENSE-oh-my-pi.txt` (MIT; see "Licensing" below)
- **Date pinned**: 2026-10-14
- **Cross-checked against installed `omp` CLI version**: `omp/18.10.1` (`omp --version`), i.e. the
  pinned schema package version matches the installed CLI version exactly at pin time.

Note: `package/src/modes/rpc/wire/rpc-wire.generated.ts` was vendored alongside the schema in an
earlier pass of this pin but has since been dropped (2026-10-14 gate remediation, issue #519/#795
part 4 HIGH/MEDIUM findings): it was never byte-identical upstream (a 2-line `AUTO-GENERATED`
header was prepended on copy, contradicting the "verbatim" claim above), it collided with
`scripts/check-file-size.mjs`'s `.ts`-extension scan (only excluded by the accident of that
prepended header tripping its generated-file-marker heuristic), and `check-omp-schema-drift.mjs`
no longer needs its text: the drift check now matches wire literals against
`rpc-wire.schema.json`'s own `x-rpc.commands[].name` list and `$defs` `const`/`enum` values
directly, which is everything the generated TS types encoded as literal unions in the first place.

## Licensing

`@oh-my-pi/pi-coding-agent` is MIT-licensed. `LICENSE-oh-my-pi.txt` in this directory is that
package's own `LICENSE` file, copied verbatim from the same `npm pack` extraction as the schema
above (confirmed via `npm view @oh-my-pi/pi-coding-agent license` -> `MIT`).

## Keeping this pin current

Run `node scripts/check-omp-schema-drift.mjs --check-pin` to compare this pinned version against
whatever `@oh-my-pi/pi-coding-agent` currently publishes on the npm registry. That check is
informational only (exits 0 regardless) -- re-vendor `rpc-wire.schema.json` and update this
document by hand when it reports the pin differs from the registry.

## Scope note (issue #519 / #795 part 4)

Full codegen of `src/shared/frames.ts` or new Rust wire structs directly from this schema is
explicitly out of scope for this slice: `frames.ts`/`model.ts`/`ipc.ts` are the single most shared
files in the repo and churning them here would collide with in-flight lane work (notably R3,
issue #786, PR #827, which is actively editing `session/agent` and `ipc/mod.rs` against the
current hand-written shapes). This vendored pin + `scripts/check-omp-schema-drift.mjs` is the safe
subset: it proves schema drift is detectable without touching any shared file.
