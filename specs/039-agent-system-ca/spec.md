# Feature Specification: Agents trust the OS certificate store

**Feature Branch**: `agent-tls-trust-1287`
**Status**: Draft
**Input**: Issue #1287 (p1 bug). On a TLS-inspecting network (Falcon, Zscaler, Netskope) every model call from OMP fails, because OMP runs on Bun, which ignores the Windows certificate store. #1284's TLS hint depends on this fix.

## Clarifications

### Session 2026-10-29 (grill, Stuart)

- Q: Does the Bun inside `omp` honour a system-CA option? -> A: Yes, proven live. omp 18.13.3, Falcon-inspected machine, `NODE_EXTRA_CA_CERTS` unset: with no CA variable the model call hangs without a reply (75 s); with `NODE_USE_SYSTEM_CA=1` it replies. The PEM export fallback in the issue is therefore not built.
- Q: Which spawns get it? -> A: The agent spawn (`omp/process.rs`) only. The config probe (`omp/config.rs`) runs the network-free CLI and stays unchanged.
- Q: What if the user set the variable already? -> A: Their value wins; Refract sets it on the child only when unset. A user `NODE_EXTRA_CA_CERTS` is inherited untouched, so its certificates are kept.
- Q: #1284's hint text? -> A: "Your network or security software is inspecting TLS. Restart the agent to load the current certificates." Changed by the #1284 bundle.
- Clarify pass: no further ambiguity.

## Requirements

- FR-001: Every agent launch sets `NODE_USE_SYSTEM_CA=1` on the `omp` child unless the user's environment already defines it.
- FR-002: The user's own environment is never modified.
- FR-003: Nothing is exported, cached or logged; the OS store is read by the agent at its start, so restarting the agent after a CA rotation fixes the failure.
- FR-004: Networks without TLS inspection are unaffected (the system store is a superset of Bun's bundled roots).

## Success criteria

- SC-001: With `NODE_EXTRA_CA_CERTS` unset, an agent started by Refract completes a model call behind Falcon.
- SC-002: Existing `cargo test` stays green. No new tests (the issue asks for none).
