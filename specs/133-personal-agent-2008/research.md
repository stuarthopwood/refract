# Research: Personal Agent

All decisions come from the epic and #2004 grill (Stuart grill 2026-11-16). This file records the code facts that fix the shape and the alternatives rejected.

## R1. Where the Session shape lives

- **Decision**: extend the persisted `Session` in `src-tauri/src/store/registry.rs:33-74` with `kind` and optional repository fields; mirror in `src/shared/model.ts:33-57` as a discriminated union.
- **Why**: `RegistryStore` already owns every Session mutation (`add_session`, `update_session`, `remove_session`), so the invariants go there once and no caller can bypass them.
- **Rejected**: a separate `personalAgent` object beside `sessions` in `registry.json`. The conversation system, agent manager, readout, notifications and list all key on a Session id; a parallel record would need a second path through all of them (decision 1: reuse the conversation system).

## R2. Backward compatibility of `registry.json`

- **Decision**: `#[serde(default)]` on `kind` with default `project`. Project rows keep string repository fields; `personal` rows write `null`.
- **Why**: `read_json_file` (`store/atomic_json.rs:25-31`) quarantines any unparseable file and starts empty, so a deserialise error on an old registry would silently drop every Session. A field with a default cannot fail an old file.
- **Edge**: with optional fields a `project` row that lost a field no longer fails deserialisation. `RegistryStore::open` therefore validates after read and handles it exactly like a malformed file today (quarantine, default), so it is never reinterpreted as `personal` (spec edge case).

## R3. Rust shape: optional fields, not an enum

- **Decision**: flat struct, `Option<String>` fields, `project_binding()` accessor.
- **Why**: keeps the on-disk and wire layout flat, keeps `SessionPatch` and the many test literals mechanical to update, and `Option` makes each reader a compile error.
- **Rejected**: `enum Session { Project(..), Personal(..) }`. Larger rewrite of persistence and fixtures; no safety gain over `Option`.

## R4. Interface shape: discriminated union

- **Decision**: `ProjectSession | PersonalSession` on `kind`; `PersonalSession` fields are `null`.
- **Why**: precedent `TouchedRef.repositoryId: string | null` (`model.ts:258-261`); a union makes a missing check a compile error (FR-007).
- **Consequence**: `SessionSummary extends Session` (`ipc.ts:120`) cannot extend a union; it becomes an intersection alias. `Pick<Session, 'repositoryId'>` style uses (for example `createdSessionAnnouncement.ts:11`) need the union handled.

## R5. Archive and delete refusal

- **Decision**: refuse in the registry store (backstop) and in the two handlers before side effects.
- **Why**: `sessions_archive` stops the agent and clears watchers before it patches (`sessions_lifecycle.rs:221-248`); a refusal after that would leave a stopped agent behind (spec edge case: "the agent keeps running"). `sessions_delete` resolves the repository at `:407-410` and would otherwise fail with a misleading "Project not found".

## R6. Working directory (decided, verify live)

- **Decision**: home folder resolved at each launch, never stored (decision 5).
- **Code facts**: the agent cwd is the worktree at `session/agent/launch.rs:180-182`; non-repository cwd precedent in `ipc/readiness.rs:300-301` and `omp/login_providers.rs:66-67`.
- **Unknown (OQ-5)**: whether omp needs a git repository for any path it uses. #2005 probes this first; a gap is raised upstream, not worked around.

## R7. Doc and glossary changes

- `CONTEXT.md` has the **Personal Agent** term (commit `8989e854`).
- Constitution Principle I and III need an amendment with a version bump (MINOR: new guidance), and a FINDINGS item records the probe; both land with #2005, where launch changes.
- `docs/PLAN.md` already has rows for #2008 and #2004-#2007; they move with the work.

## R8. Alternatives for the feature as a whole (decided in the grill)

- Multiple user-created project-less Sessions: rejected (decision 1; out of scope).
- A sandboxed or picked folder: rejected (decision 5; Stuart's explicit choice of the home folder).
- Hiding repo-only features: rejected (decision 7: show disabled with an explanation).
