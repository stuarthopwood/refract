// Reads and writes OMP model roles via the `omp config` CLI (issue #455). `omp config get
// modelRoles --json` returns the whole `modelRoles` record as ONE value -- dotted per-key access
// (`modelRoles.<role>`) returns "Unknown setting", confirmed live on omp 18.8.0 (this module's own
// live isolated-profile check, recorded in `docs/spike/FINDINGS.md`; 18.4.x/18.5.x are NOT
// independently re-verified here -- labelled unverified on those pinned versions per constitution
// Principle IV) -- so there is no cheaper single-role read or write. `omp config set modelRoles
// '<json>' --json` always writes the GLOBAL config.yml, never a project override (`omp://
// settings.md` "Where writes go": "Settings commands do not write arbitrary project keys"), which
// answers issue #455's own "which scope does Refract write" open question directly from the CLI's
// documented behaviour -- there is no project-scoped write path through this CLI surface at all.
//
// execFile only, no shell, an absolute resolved path (`resolveExecutable`, the same security
// discipline as `git/git.ts`/`github/gh.ts`: never a bare name Windows would resolve against the
// spawn's cwd before PATH), bounded stdout (`maxBuffer`), a fixed role-name/catalog-kind
// vocabulary, and a length/control-character limit on the model selector text -- never arbitrary
// caller text reaching the argv unchecked. Every `omp` invocation runs with its cwd pointed at a
// dedicated, Refract-owned scratch directory under the OS temp root (created once, reused, never
// deleted), not the bare shared temp root itself: `omp` loads a project config from `<cwd>/.omp/`
// whenever that folder is non-empty, so running directly in a generic, widely-shared temp location
// would let anything else that happens to drop a `.omp/config.yml` there inject settings into
// every call this module makes (quality-gate remediation, security-auditor MEDIUM). This directory
// is intentionally never programmatically removed (project convention: a delete target must be a
// literal path, never built from a reused/computed variable) -- it stays empty in normal operation
// (nothing in this module or `omp` itself writes ordinary files into it for these commands), so
// leaving it costs nothing.
//
// `setModelRole`'s read-merge-write is serialised through a module-level promise chain
// (`enqueueWrite`) so two near-simultaneous role edits from THIS process never race each other
// (quality-gate remediation, code-reviewer/security-auditor HIGH): without it, changing role A
// then role B before A's write lands starts two independent read-merge-writes against the same
// starting record, and the later write silently drops the earlier change. This only protects
// calls made through this module -- an outside writer (the user running `omp` or `/model`
// directly while Refract is open) can still interleave between this chain's own read and write,
// since `omp`'s own file lock covers only the single `set` call, not a whole read-merge-write
// cycle; this is a real residual gap, not closed by anything this module can do alone.

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../process/executables';
import { isCatalogKind, isModelRoleId } from '../../shared/model';
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model';

const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1_048_576; // 1 MiB: bounded output, matching tool policy.
const MAX_ROLE_VALUE_LENGTH = 512; // Well under Windows' ~32K command-line limit; no real selector is this long.

export type OmpConfigErrorCode = 'omp-not-found' | 'omp-failed' | 'timeout' | 'parse-failed' | 'invalid-value';

export class OmpConfigError extends Error {
  readonly code: OmpConfigErrorCode;
  constructor(code: OmpConfigErrorCode, message: string) {
    super(message);
    this.name = 'OmpConfigError';
    this.code = code;
  }
}

interface OmpRawResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

// A fixed, Refract-owned scratch directory (never the bare shared `os.tmpdir()` root itself --
// see module header). Created lazily, once, and reused for every `omp` invocation this module
// makes; never removed.
const CONFIG_SCRATCH_DIR = path.join(os.tmpdir(), 'refract-omp-config-scratch');
let scratchDirReady: Promise<string> | undefined;

async function ensureScratchDir(): Promise<string> {
  if (!scratchDirReady) {
    scratchDirReady = fsp.mkdir(CONFIG_SCRATCH_DIR, { recursive: true }).then(() => CONFIG_SCRATCH_DIR);
  }
  return scratchDirReady;
}

// Quality-gate remediation (security-auditor MEDIUM): `omp config get` returns the EFFECTIVE
// value, which can be sourced from a runtime override rather than anything actually persisted in
// global config.yml (`omp://settings.md` "Environment overrides"). Reading the record to MERGE
// before a write with these four stripped means `setModelRole` only ever folds the global/project/
// overlay layers into the record it writes back -- never a transient `PI_*_MODEL` role override or
// a `--config`-overlay-selected value -- so a Session launched with, say, `PI_SMOL_MODEL` set can
// never get that value silently baked into the user's persisted global config by an unrelated role
// edit. The PUBLIC `getModelRoles()` (used only for display) deliberately does NOT strip these: the
// user should see the true effective value when just looking at what a role currently resolves to.
const ROLE_OVERRIDE_ENV_VARS = ['PI_SMOL_MODEL', 'PI_SLOW_MODEL', 'PI_PLAN_MODEL', 'PI_CONFIG_FILES'] as const;

function envWithoutRoleOverrides(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ROLE_OVERRIDE_ENV_VARS) delete env[key];
  return env;
}

/** Runs `omp <args>` with no shell, cwd pointed at the shared scratch directory (see module
 * header). Mirrors `github/gh.ts`'s `ghRaw` discipline otherwise: an `AbortController` timeout, an
 * absolute resolved path, never throws for a nonzero exit -- callers branch on `.code`/
 * `.timedOut`. Throws `OmpConfigError('omp-not-found', ...)` only when `omp` itself cannot be
 * found on PATH.
 *
 * Executor form (not `Promise.withResolvers()`): the same documented exception `github/gh.ts`'s
 * own `ghRaw` already carries -- `Promise.withResolvers()` needs lib "ES2024",
 * `tsconfig.node.json` is pinned to "ES2023". */
async function ompRaw(args: string[], envOverride?: NodeJS.ProcessEnv): Promise<OmpRawResult> {
  let ompPath: string;
  try {
    ompPath = await resolveExecutable('omp');
  } catch {
    throw new OmpConfigError('omp-not-found', 'omp is not installed or not on PATH.');
  }
  const scratchDir = await ensureScratchDir();
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    execFile(
      ompPath,
      args,
      { cwd: scratchDir, env: envOverride ?? process.env, windowsHide: true, signal: controller.signal, maxBuffer: MAX_STDOUT_BYTES },
      (error: Error | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        let code = 0;
        // `in` narrows `error.code` to `unknown` (no cast): Node's child_process callback error
        // carries either a numeric exit code or a string errno (e.g. "ENOENT") here.
        if (error !== null && 'code' in error) {
          const rawCode = error.code;
          code = typeof rawCode === 'number' ? rawCode : 1;
        } else if (error !== null) {
          code = 1;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, timedOut });
      }
    );
  });
}

/** Runs `omp <args>`, mapping a timeout or nonzero exit to `OmpConfigError`. Never logs or
 * attaches raw stderr beyond a short, bounded slice to the thrown error's own message (sent only
 * to the caller, which in this app's case is the renderer's own inline/Alert text, never a
 * persisted log) -- this is the one place a credential-adjacent CLI failure text could otherwise
 * leak further. */
async function run(args: string[], failureMessage: string, envOverride?: NodeJS.ProcessEnv): Promise<OmpRawResult> {
  const result = await ompRaw(args, envOverride);
  if (result.timedOut) {
    throw new OmpConfigError('timeout', 'omp config timed out.');
  }
  if (result.code !== 0) {
    throw new OmpConfigError('omp-failed', result.stderr.trim().slice(0, 500) || failureMessage);
  }
  return result;
}

/** Generic CLI-JSON-output parse, matching `github/gh.ts`'s established `ghJson<T>` convention
 * for trusting a documented CLI's own `--json` shape. Rejects `null` and non-object JSON (a bare
 * string/number/boolean) up front -- every shape this module actually consumes (`{key, value,
 * ...}`, `{models: [...]}`, or a bare array) is an object, so a non-object result is always a
 * malformed response, not a valid-but-unexpected one. */
function parseJson<T>(stdout: string): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new OmpConfigError('parse-failed', 'omp returned output that was not valid JSON.');
  }
  if (value === null || typeof value !== 'object') {
    throw new OmpConfigError('parse-failed', 'omp returned a JSON value that was not an object.');
  }
  return value as T;
}

export interface OmpConfigGetJson {
  key: string;
  value: unknown;
  type: string;
  description?: string;
}

export interface OmpConfigSetJson extends OmpConfigGetJson {
  overriddenBy?: string;
  fallbackEnv?: string;
}

/** Validates that `value` is a plain, non-array object (the shape `omp config get/set modelRoles`
 * always returns for a record-typed key) and returns a shallow copy, WITHOUT converting or
 * dropping any entry -- used to build the raw record `setModelRole` merges into and writes back,
 * so a non-string entry OMP itself may store (the docs describe role values as "primary selector
 * or ordered primary candidates", which could be an array) is never silently deleted by an
 * unrelated role edit (quality-gate remediation, code-reviewer/security-auditor MEDIUM). Exported
 * for direct unit testing (no CLI invocation needed). */
export function rawModelRolesRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OmpConfigError('parse-failed', 'omp config returned a non-record modelRoles value.');
  }
  return { ...(value as Record<string, unknown>) };
}

/** Narrows a raw modelRoles record down to the string-only view the renderer actually understands
 * and can show in a picker -- entries the rest of this module does not know how to render (a
 * record is never UI-filtered away by this call, only hidden from display; `rawModelRolesRecord`
 * is still what gets merged and written). Exported for direct unit testing. */
export function stringEntriesOnly(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** Pure merge step for `setModelRole`: applies one role change (a selector string, or `null` to
 * clear) to a raw modelRoles record without touching any other key, including entries this module
 * does not itself understand. Returns the exact SAME object reference when clearing a role that
 * was already absent, so callers can detect a no-op merge and skip a needless `omp config set`
 * call entirely (quality-gate remediation, test-reviewer LOW: avoids ever writing a bare
 * `modelRoles: {}` into a fresh profile's config.yml for a clear that changes nothing). Exported
 * for direct unit testing. */
export function mergeModelRole(current: Record<string, unknown>, role: string, value: string | null): Record<string, unknown> {
  if (value === null) {
    if (!(role in current)) return current;
    const next = { ...current };
    delete next[role];
    return next;
  }
  return { ...current, [role]: value };
}

async function readModelRolesRaw(envOverride?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const result = await run(['config', 'get', 'modelRoles', '--json'], 'omp config get modelRoles failed.', envOverride);
  const parsed = parseJson<OmpConfigGetJson>(result.stdout);
  return rawModelRolesRecord(parsed.value);
}

/** `omp config get modelRoles --json` (confirmed live, omp 18.8.0, see `docs/spike/FINDINGS.md`):
 * the whole `modelRoles` record in one call, as the TRUE effective value (environment overrides
 * included -- this is for display, not for merging-before-write; see `readModelRolesRaw`'s own
 * comment). A role absent from the returned record is unset (inherits its documented fallback,
 * e.g. `tiny` falls back to `@smol`). */
export async function getModelRoles(): Promise<Record<string, string>> {
  return stringEntriesOnly(await readModelRolesRaw());
}

export interface SetModelRoleResult {
  roles: Record<string, string>;
  /** Present when a higher-priority layer still supplies the effective value for the role just
   * written -- `omp config set`'s own documented `--json` field (`omp://settings.md`
   * "Subcommands"). */
  overriddenBy?: string;
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Serialises every `setModelRole` call through one promise chain (see module header for why).
 * `writeChain` is always resettled to a void, never-rejecting promise after `task` finishes
 * (success or failure), so one failed write never permanently wedges every later call behind a
 * rejected chain link. Exported for direct unit testing of the serialisation guarantee itself
 * (quality-gate remediation, code-reviewer/security-auditor HIGH), independent of the real
 * `omp` CLI timing. */
export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const chained = writeChain.then(task, task);
  writeChain = chained.then(
    () => undefined,
    () => undefined
  );
  return chained;
}

function assertValidSelector(value: string): void {
  if (value.trim().length === 0) {
    throw new OmpConfigError('invalid-value', 'Model selector cannot be blank.');
  }
  if (value.length > MAX_ROLE_VALUE_LENGTH) {
    throw new OmpConfigError('invalid-value', `Model selector is too long (max ${MAX_ROLE_VALUE_LENGTH} characters).`);
  }
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters, including newlines, that must never reach argv.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new OmpConfigError('invalid-value', 'Model selector contains control characters.');
  }
}

/** Sets or clears one role. `value: null` clears the role (deletes the key from the record)
 * rather than writing a JSON `null`: a project `modelRoles` tombstone is a `settings.ts` API
 * concept (`setProjectModelRole`/`clearProjectModelRole`), not something this CLI surface exposes,
 * and `set` only ever writes the global layer regardless (see module header). Validates the
 * selector shape before ever entering the write queue; defensive-validates the role name too
 * (redundant with the IPC layer's own `isModelRoleId` check, matching this codebase's established
 * independent-second-layer convention, e.g. `SettingsStore`'s own shape checks). */
export async function setModelRole(role: ModelRoleId, value: string | null): Promise<SetModelRoleResult> {
  if (!isModelRoleId(role)) {
    throw new OmpConfigError('invalid-value', `Unknown model role: ${String(role)}`);
  }
  if (value !== null) {
    assertValidSelector(value);
  }
  return enqueueWrite(() => setModelRoleNow(role, value));
}

async function setModelRoleNow(role: ModelRoleId, value: string | null): Promise<SetModelRoleResult> {
  const current = await readModelRolesRaw(envWithoutRoleOverrides());
  const next = mergeModelRole(current, role, value);
  if (next === current) {
    // Clearing an already-unset role: nothing changed, so skip the `omp config set` call
    // entirely (see `mergeModelRole`'s own comment).
    return { roles: stringEntriesOnly(current) };
  }
  const result = await run(['config', 'set', 'modelRoles', JSON.stringify(next), '--json'], 'omp config set modelRoles failed.');
  const parsed = parseJson<OmpConfigSetJson>(result.stdout);
  // `omp config set --json` is documented to echo the written `value`; if it ever does not,
  // re-read the record from `omp` itself rather than trusting the `next` this call already
  // computed (a stale local guess could diverge from what `omp` server-side normalisation
  // actually persisted) or returning `{}` (which would make the UI show every role as freshly
  // unset right after a successful write).
  const writtenRaw = parsed.value === undefined ? await readModelRolesRaw() : rawModelRolesRecord(parsed.value);
  return {
    roles: stringEntriesOnly(writtenRaw),
    overriddenBy: typeof parsed.overriddenBy === 'string' ? parsed.overriddenBy : undefined,
  };
}

interface OmpModelsJson {
  models?: unknown;
}

/** Pure response-shape handling for `omp models --kind <kind> --json`: accepts either a bare
 * top-level array or `{ models: [...] }` (confirmed live, omp 18.8.0, both on a fresh isolated
 * profile with zero models and on the real signed-in profile -- see `docs/spike/FINDINGS.md`),
 * and validates each row before trusting it. Exported for direct unit testing (no CLI invocation
 * needed). */
export function parseCatalogResponse(parsed: unknown): ModelCatalogEntry[] {
  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as OmpModelsJson).models)) {
    rows = (parsed as OmpModelsJson).models as unknown[];
  } else {
    throw new OmpConfigError('parse-failed', 'omp models returned neither an array nor { models: [...] }.');
  }
  const entries: ModelCatalogEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (!('provider' in row) || !('id' in row) || !('selector' in row) || !('name' in row)) continue;
    // Each destructured field narrows to `unknown` from the `in` checks above (no cast); the
    // `typeof` checks below are the real validation before anything is trusted.
    const { provider, id, selector, name } = row;
    if (typeof provider === 'string' && typeof id === 'string' && typeof selector === 'string' && typeof name === 'string') {
      entries.push({ provider, id, selector, name });
    }
  }
  return entries;
}

/** `omp models --kind <kind> --json` (`omp://models.md` "`/model` and `omp models`"): a read-only
 * catalog listing, independent of any live RPC session -- this is how the Role picker gets model
 * options without the Session-bound `get_available_models` RPC call, which FINDINGS item 21 found
 * carries no role field anyway and which lives behind `OmpProcess.ts`/`SessionAgent.ts` (Phase A
 * files this story does not touch). */
export async function listCatalogModels(kind: CatalogKind): Promise<ModelCatalogEntry[]> {
  if (!isCatalogKind(kind)) {
    throw new OmpConfigError('invalid-value', `Unknown catalog kind: ${String(kind)}`);
  }
  const result = await run(['models', '--kind', kind, '--json'], 'omp models failed.');
  const parsed = parseJson<unknown>(result.stdout);
  return parseCatalogResponse(parsed);
}
