// Lane RM (#454, #740, #741, #762, #766): the model/role IPC contract, split into its own file
// rather than inlined in `ipc.ts`/`model.ts` to keep both comfortably at their existing
// file-size baseline (issue #806, `scripts/check-file-size.mjs`) -- pure addition, no existing
// export moves.

import type { Result } from './ipc';

/** A resolved OMP model (`get_state().model`, FINDINGS "RM0 probe" item 30/51): `provider`/`id`
 * always present, `name` the catalog's friendly display name when OMP reports one (#741: the
 * provider-free label comes from this field, falling back to `provider/id` when absent, never
 * built by splitting an id string on `/`). Lane RM's own `ModelApi` calls below all return this
 * same shape. */
export interface Model {
  provider: string;
  id: string;
  name?: string;
}

/** Lane RM (#740): `RefractApi.modelRoles.set`'s own propagation summary after sweeping every
 * live Session for one that was on the changed role. Gate-fix (MEDIUM): each bucket names the
 * Sessions in it (their display `name`), not just a count, so the Settings page's own polite
 * result can say which Sessions moved/were skipped and why ("Moved 'bold-merlin'..., left
 * 'fond-orca' pinned"). Field names match Rust's `#[serde(rename_all = "camelCase")]`
 * `RoleChangeSummary` (`session::model`) exactly. */
export interface RoleChangeSummary {
  moved: string[];
  queued: string[];
  skippedPinned: string[];
  /** A Session whose live status is `Stopped` lands here: resumes its own saved model on its
   * next real start, not counted as a failure. This requires an agent entry to already exist
   * (a prior open, or even a read-only model probe) -- a Session with NO entry at all (truly
   * untouched this run) is invisible to the sweep and is absent from every bucket, not this one,
   * though the outcome for it is the same: it resumes its own saved model on its next start. */
  skippedStopped: string[];
  failed: string[];
}

/** `omp://rpc.md`'s own `ThinkingLevel` vocabulary (confirmed live, FINDINGS "RM0 probe" closing
 * entry and `docs/spike/FINDINGS.md`'s Spec 003 gate-probe item 1): the ONLY values OMP's
 * `set_thinking_level` RPC accepts for `ModelApi.setThinkingLevel` below. Same union `frames.ts`'s
 * own `thinkingLevel` field documents, carried there as a plain `string` (a read-only passthrough,
 * never validated against this list there) -- this type constrains the OUTBOUND argument, which
 * the Rust handler NOW ALSO validates against the identical closed set before sending anything to
 * OMP (gate round 1, 2026-10-15: previously unchecked, forwarded verbatim). */
export type ThinkingLevel = 'off' | 'inherit' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Per-Session model/role/reasoning actions over the live RPC connection (never OMP's config --
 * see `RefractApi.modelRoles` for that): the composer picker's `setModel`/`cycleModel`, the
 * Reasoning picker's `setThinkingLevel` (#564), and the role selector (`/role`, Ctrl+R)'s
 * `applyRole`/`listRoles`. Every call refuses with `'not-idle'` while the Session is working
 * (FINDINGS "RM0 probe" item 57's own closing entry: mid-turn `set_model` is not provably safe
 * on `omp` 18.10.1, a regression from a clean 18.8.0 pass) -- refused outright, never queued,
 * except #740's own Settings-triggered role reapply, which is not driven through this API at all
 * (it runs Session-side on its own next settle). The Rust build is the only implementation --
 * Electron never ported this family, and Electron itself is gone (R13, 2026-10-15, #873), so
 * `RefractApi.model` below is no longer optional. */
export interface ModelApi {
  /** `set_model { provider, modelId }`: Session-scoped only (OMP's own description, "for this
   * session only" -- never writes `modelRoles`); pins the Session (a later Settings role
   * change, #740, leaves it alone) and clears any tracked role. */
  setModel(sessionId: string, provider: string, modelId: string): Promise<Result<{ model: Model }>>;
  /** `cycle_model`: steps through catalog models, NOT roles (FINDINGS item 54 corrects
   * `omp://settings.md`'s own `cycleOrder` description for this specific RPC command) -- pins
   * the Session exactly like `setModel` (a concrete model was just chosen, not a role). */
  cycleModel(sessionId: string): Promise<Result<{ model: Model }>>;
  /** Forwards OMP's own native `/switch @<role>` (FINDINGS item 54: proven to resolve the role
   * alias correctly; constitution I: Refract does not reimplement `modelRoles`/`cycleOrder`
   * resolution OMP already does). Un-pins the Session and records `role` as its own tracked
   * role (OMP's RPC surface carries no role field anywhere, FINDINGS item 21/51 -- never read
   * back from OMP). `role` must be one of `listRoles`' own `roles[].role` values: an unknown
   * role is refused locally (`'invalid-argument'`) before anything is sent, since OMP's own
   * text command silently no-ops on one it cannot resolve rather than erroring (FINDINGS item
   * 53's documented gap). */
  applyRole(sessionId: string, role: string): Promise<Result<{ model: Model; role: string }>>;
  /** The Ctrl+R selector's own listing (and `/role`'s own argument validation source):
   * `cycleOrder` plus the literal `"plan"` role (Stuart 2026-10-13), each with its configured
   * `modelRoles` selector (the raw string; the renderer's own catalog lookup turns it into a
   * friendly, provider-free name, #741) and whether it is this Session's current role. */
  listRoles(sessionId: string): Promise<
    Result<{
      roles: Array<{ role: string; model: string | null; current: boolean }>;
      currentRole: string | null;
      pinned: boolean;
    }>
  >;
  /** `set_thinking_level { level }` (#564, the composer's Reasoning picker): session-scoped
   * only, forwarding OMP's own RPC after validating `level` against the closed set above --
   * never pins the Session or touches its tracked role (unlike `setModel`/`cycleModel`/
   * `applyRole`, reasoning effort is orthogonal to which model/role is selected). Same refusal
   * rules as `setModel` (`'not-idle'` while working). The resolved `thinkingLevel` is `null`
   * (gate round 1, 2026-10-15, amended by Stuart) when OMP's `get_state` does not report a level
   * back for a successful switch -- which OMP does both for `'inherit'` itself (resolved instead
   * to `null` here ONLY if the request was for a different level the model did not confirm; a
   * successful `'inherit'` request always resolves to the literal string `'inherit'`, never
   * `null`, since Default is always a valid outcome regardless of whether the model echoes it)
   * and for any OTHER level on a model that does not report reasoning effort at all. `null` MUST
   * NOT be treated as an error: the renderer shows "Reasoning not reported" for it, never a
   * toast, since the underlying `set_thinking_level` RPC itself already succeeded. */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<Result<{ thinkingLevel: string | null }>>;
}

