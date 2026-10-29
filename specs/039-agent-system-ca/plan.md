# Plan: Agents trust the OS certificate store

Spec: `spec.md`.

- `src-tauri/src/omp/process_args.rs`: new `trust_system_ca(&mut Command)` sets `NODE_USE_SYSTEM_CA=1` when the parent environment has no value. Lives here because `process.rs` is a baselined file (cap 1094) and must not grow past it.
- `src-tauri/src/omp/process.rs`: one call after the stdio setup of the agent `Command`.
- `docs/PLAN.md`: status note on the wave 3 Chat transcript row.
- No UI, IPC, settings or dependency changes. Constitution Principle V: no secret handled, nothing logged.
