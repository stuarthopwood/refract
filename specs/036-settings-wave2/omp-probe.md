# OMP role-inheritance probe (T6)

Date: 2026-10-29. Installed OMP: `omp v18.13.3` (`omp.exe` in `%LOCALAPPDATA%\omp`). The task named 18.10.1 as the supported version; the machine has 18.13.3, so results are for 18.13.3.

Isolation: every command used `--profile probe035` (agent dir `C:\Users\shopwood\.omp\profiles\probe035\agent`, confirmed by `omp --profile probe035 config path`). The real `~/.omp` config and running Sessions were not touched. The scratch profile has no API keys and no login, so it has no models.

## Commands and raw output

```
> omp --profile probe035 config get modelRoles --json
{ "key": "modelRoles", "value": {}, "type": "record", "description": "" }

> omp --profile probe035 config get modelRoles.<role>     (smol, slow, tiny, memory, advisor, widget, default)
Unknown setting: modelRoles.<role>
Run 'omp config list' to see available keys

> omp --profile probe035 config set modelRoles.smol anthropic/x
Unknown setting: modelRoles.smol

> omp --profile probe035 models
No models available. Set API keys in environment variables.

> echo {"type":"get_state","id":"1"} | omp --profile probe035 --mode rpc --no-session
No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.
```

## What the sources report for unset roles

- `omp config get modelRoles` returns one record. An unset role is simply absent from it. The CLI has no per-role key (`modelRoles.<role>` is "Unknown setting"), so it reports no fallback for any role.
- `omp models` lists the catalog only; it has no role information.
- RPC `get_state` reports the active model only, and needs a resolvable model. It cannot show how an unset role resolves, and it could not be run on the keyless scratch profile.
- The only inheritance logic Refract has is its own mirror of `omp://models.md`: `direct_selector_with_fallback` in `src-tauri/src/session/model/model_support.rs` (unset `smol` and `slow` inherit an explicitly configured `default`; `@role` alias hop resolves one level). It was live-verified in an earlier round (its doc comment cites round 8).

## Table

| Role | Documented inherits-from | Status | Source Refract can read |
|---|---|---|---|
| smol | explicitly configured `default` | CONFIRMED (earlier live verification, `model_support.rs`; not re-proved by this probe) | `omp config get modelRoles` (`default` present or absent) |
| slow | explicitly configured `default` | CONFIRMED (same) | same |
| tiny | `@smol` | NOT CONFIRMED (no CLI/RPC output shows it) | none; documentation only |
| memory | `@tiny` | NOT CONFIRMED | none; documentation only |
| advisor | explicitly configured `slow`, else its own chain | NOT CONFIRMED | none; documentation only |
| widget | like `smol` | NOT CONFIRMED (new role) | none; documentation only |

## Guidance for T7

- Only display "inherits default" for `smol` and `slow`, derived from the `modelRoles` record: show the `default` value when set, else "OMP picks one automatically".
- For `tiny`, `memory`, `advisor` and `widget`, use the neutral text "OMP picks one automatically" unless a logged-in probe (with an API key) confirms the link.
- To close the gap: re-run the probe on a logged-in scratch profile and read the resolved model from RPC `get_state` after setting only the upstream role.
