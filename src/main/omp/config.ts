// Reads and writes OMP model roles via the `omp config` CLI (issue #455). `omp config get
// modelRoles --json` returns the whole `modelRoles` record as ONE value -- dotted per-key access
// (`modelRoles.<role>`) returns "Unknown setting", confirmed live on omp 18.8.0 (this module's own
// live isolated-profile check, recorded in `docs/spike/FINDINGS.md`; 18.4.x/18.5.x are NOT
// independently re-verified here -- labelled unverified on those pinned versions per constitution
// Principle IV) -- so there is no cheaper single-role read or write. `omp config set modelRoles
// '<json>' --json` always writes the GLOBAL config.yml, never a project override -- `omp://
// settings.md`'s own Subcommands table states this for `config set` specifically ("Ordinary
// persistent writes land in the global file"), and this is now also confirmed live even with
// `modelRoleStorage: project` explicitly set (`docs/spike/model-roles-probe.mjs`, FINDINGS item
// 48): the write still landed in the global file, and no project `.omp/config.yml` was created in
// the scratch cwd. This answers issue #455's own "which scope does Refract write" open question.
//
// execFile only, no shell, an absolute resolved path (`resolveExecutable`, the same security
// discipline as `git/git.ts`/`github/gh.ts`: never a bare name Windows would resolve against the
// spawn's cwd before PATH), bounded stdout (`maxBuffer`), a fixed role-name/catalog-kind
// vocabulary, and a length/control-character limit on the model selector text -- never arbitrary
// caller text reaching the argv unchecked. Every `omp` invocation runs with its cwd pointed at a
// scratch directory this module creates itself with `fsp.mkdtemp` (quality-gate remediation, gate
// cycle 4 MEDIUM+LOW, code-reviewer/security-auditor): `omp` loads a project config from `<cwd>/
// .omp/` whenever that folder is non-empty, so a FIXED, predictable scratch path (the gate cycle
// 2/3 design) could in principle have something written into it between an emptiness check and
// the `omp` spawn (a TOCTOU gap), and any single stray entry there permanently broke every model-
// role call with no actionable recovery. `mkdtemp` closes both at once: it creates a directory
// with an unpredictable name, empty AT CREATION, in one atomic call -- quality-gate remediation,
// gate cycle 5 LOW, security-auditor: this is NOT a claim that foreign content can never later
// exist there, only that nothing else was ever told the path at the moment it was created; any
// same-user process COULD in principle discover it afterward by listing the OS temp root and
// plant something, but that crosses no privilege boundary a same-user process does not already
// have (it could edit the real global `config.yml` directly) -- and a missing directory (first
// call, or deleted by Windows temp cleanup) is simply recreated. ONE such directory is created
// lazily on first use and reused for the rest of this process's life (quality-gate remediation,
// gate cycle 5 MEDIUM, code-reviewer/security-auditor/test-reviewer: the in-flight CREATION
// itself is now memoised too, not just the resolved path -- several concurrent first calls, e.g.
// the Settings mount effect's `load()` plus one `loadCatalog` per catalog kind firing together,
// used to each see no cached directory yet and each start their OWN `mkdtemp`, leaving every
// extra one an orphaned, never-cleaned-up empty directory; now every concurrent caller joins the
// SAME in-flight `mkdtemp` call). `cleanupModelRolesScratchDir` (called from `index.ts`'s own
// `before-quit`, the same lifecycle hook `SessionManager.stopAll()` uses, and a no-op after its
// first call whether or not that call actually removed anything -- an `omp` process still running
// at quit, or a Windows shutdown/logoff that never fires `before-quit` at all, can both leave the
// directory behind) awaits any creation still in flight, then removes the resolved path -- the
// EXACT literal path `mkdtemp` returned, never a reconstructed or wildcard path -- best-effort and
// never blocking quit. Leaving it on disk if cleanup is skipped costs nothing beyond a few bytes
// of unpredictably-named temp-folder litter: `os.tmpdir()`'s own cleanup eventually reclaims it.
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

// `fsp.mkdtemp` prefix (never the bare shared `os.tmpdir()` root itself -- see module header).
const SCRATCH_DIR_PREFIX = 'refract-omp-config-';

// Cached for this process's lifetime; `null` until the first call needs it, and reset to `null`
// if a later call finds it has been removed out from under us.
let cachedScratchDir: string | null = null;

// Memoises the IN-FLIGHT `mkdtemp` call itself, not just its eventual result (quality-gate
// remediation, gate cycle 5 MEDIUM -- see module header: concurrent first calls used to each
// start their own `mkdtemp` before any of them had resolved). A second caller that arrives while
// one is already creating the directory joins that SAME promise instead of starting another.
let scratchDirPromise: Promise<string> | null = null;

/** Creates (lazily, once per process) an `fsp.mkdtemp`-randomised scratch directory and reuses it
 * for every later call, recreating it transparently if it has gone missing (quality-gate
 * remediation, gate cycle 4 MEDIUM+LOW -- see module header for why `mkdtemp` replaced the fixed
 * directory + emptiness-check design). A genuinely failing `mkdtemp` (disk full, no permission to
 * write under the OS temp root) maps to a clear, actionable `OmpConfigError`. */
async function ensureScratchDir(): Promise<string> {
  if (cachedScratchDir) {
    try {
      await fsp.access(cachedScratchDir);
      return cachedScratchDir;
    } catch {
      cachedScratchDir = null; // removed from under us (e.g. Windows temp cleanup); recreate below.
    }
  }
  if (scratchDirPromise) return scratchDirPromise;
  const creating = (async () => {
    let dir: string;
    try {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), SCRATCH_DIR_PREFIX));
    } catch {
      throw new OmpConfigError('omp-failed', 'Could not prepare a working directory for omp.');
    }
    cachedScratchDir = dir;
    return dir;
  })();
  scratchDirPromise = creating;
  try {
    return await creating;
  } finally {
    // Only clear the slot if it is still OUR OWN in-flight promise -- a later caller that already
    // started a fresh `creating` (after this one settled) must never have its own slot cleared by
    // this one finishing late.
    if (scratchDirPromise === creating) scratchDirPromise = null;
  }
}

/** Best-effort removal of the scratch directory, called once from `index.ts`'s own `before-quit`
 * handler (never blocking quit -- a failure here is not worth delaying the app over). Awaits any
 * creation still in flight first (quality-gate remediation, gate cycle 5 MEDIUM), so a quit that
 * lands mid-creation still cleans up the directory that call is about to finish making, rather
 * than orphaning it. Always the EXACT literal path `mkdtemp` returned and cached, never a
 * reconstructed or wildcard path (project convention: a delete target must never be built from a
 * guessed or computed value). Uses the plain, non-recursive removal -- nothing in this module or
 * `omp` itself ever writes ordinary files into this directory (module header), so it is always
 * empty at this point in normal operation; the plain call throws (caught and ignored below) rather
 * than silently removing anything unexpected if that assumption is ever wrong. A no-op if nothing
 * was ever created this session, and a no-op after its first call whether or not that call
 * actually removed anything (quality-gate remediation, gate cycle 5 LOW, code-reviewer/
 * security-auditor: the slot is cleared before the removal attempt either way). */
export async function cleanupModelRolesScratchDir(): Promise<void> {
  if (scratchDirPromise) {
    try {
      await scratchDirPromise;
    } catch {
      return; // mkdtemp never actually succeeded; nothing exists to remove.
    }
  }
  const target = cachedScratchDir;
  if (!target) return;
  cachedScratchDir = null;
  try {
    await fsp.rmdir(target);
  } catch {
    // Best-effort; the unpredictable name costs nothing left behind (module header).
  }
}

// Quality-gate remediation (security-auditor MEDIUM, live-probed and confirmed unverified-but-
// unobserved for `PI_SMOL_MODEL` specifically -- see FINDINGS item 48's "env override probe"):
// `omp config get` was NOT observed to reflect a `PI_SMOL_MODEL` runtime override in its returned
// value on omp 18.8.0 (the value stayed the persisted one with the override set). This stripping
// is therefore defence in depth for an UNCONFIRMED risk, not a closure of an observed hole: if a
// future `omp` version (or one of the other three variables, not independently tested) ever does
// fold a runtime override into `config get`'s reported value, stripping these four here still
// keeps `setModelRole`'s merge-before-write reading only the persisted GLOBAL layer (quality-gate
// remediation, gate cycle 3 LOW: this used to say "global/project/overlay layers", which was
// wrong twice over -- stripping `PI_CONFIG_FILES` removes the overlay layer from what the read
// sees, and `ensureScratchDir`'s always-empty cwd means no project layer is ever present for this
// module to read in the first place). `setModelRoleNow`'s own `config set` call is stripped the
// same way (previously only the read was, an asymmetry with no real-world effect given the above,
// but worth closing). The PUBLIC `getModelRoles()` (used only for display) deliberately does NOT
// strip these.
const ROLE_OVERRIDE_ENV_VARS = ['PI_SMOL_MODEL', 'PI_SLOW_MODEL', 'PI_PLAN_MODEL', 'PI_CONFIG_FILES'];

/** Exported for direct unit testing. Case-insensitive (quality-gate remediation, gate cycle 2 LOW:
 * Windows environment variable names are case-insensitive, so a variable set as `Pi_Smol_Model`
 * previously survived a case-sensitive `delete`). */
export function envWithoutRoleOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = new Set(ROLE_OVERRIDE_ENV_VARS);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!stripped.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  return result;
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

/** Runs `omp <args>`, mapping a timeout or nonzero exit to `OmpConfigError`. Never surfaces raw
 * `omp` stderr to the renderer (quality-gate remediation, security-auditor/code-reviewer LOW: a
 * YAML parse error can echo a local path or a config line) -- the fixed, caller-supplied
 * `failureMessage` is what reaches the UI; the real stderr (trimmed to 500 characters) goes only
 * to this process's own `console.warn`, never persisted or sent over IPC. */
async function run(args: string[], failureMessage: string, envOverride?: NodeJS.ProcessEnv): Promise<OmpRawResult> {
  const result = await ompRaw(args, envOverride);
  if (result.timedOut) {
    throw new OmpConfigError('timeout', 'omp config timed out.');
  }
  if (result.code !== 0) {
    if (result.stderr.trim().length > 0) {
      console.warn('[refract] omp config call failed:', result.stderr.trim().slice(0, 500));
    }
    throw new OmpConfigError('omp-failed', failureMessage);
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
 * so a non-string entry OMP itself may store is never silently deleted by an unrelated role edit
 * (quality-gate remediation, code-reviewer/security-auditor MEDIUM). Exported for direct unit
 * testing (no CLI invocation needed). */
export function rawModelRolesRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OmpConfigError('parse-failed', 'omp config returned a non-record modelRoles value.');
  }
  return { ...(value as Record<string, unknown>) };
}

/** Narrows a raw modelRoles record down to the string-only view the renderer actually understands
 * and can show in a picker. Blank (empty-after-trim) string entries are also dropped -- a
 * hand-edited `modelRoles: { smol: "" }` would otherwise render as the "Inherited" placeholder
 * option with no visible or accessible text, misrepresenting the stored value as unset when it is
 * really an empty string (quality-gate remediation, accessibility-auditor LOW). Entries this
 * module does not know how to render are never UI-filtered away from the RECORD it writes back --
 * `rawModelRolesRecord` is still what gets merged and persisted. Exported for direct unit
 * testing. */
export function stringEntriesOnly(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      result[key] = entry;
    }
  }
  return result;
}

/** Pure merge step for `setModelRole`: applies one role change (a selector string, or `null` to
 * clear) to a raw modelRoles record without touching any other key, including entries this module
 * does not itself understand, and without mutating `current`. Returns the exact SAME object
 * reference when clearing a role that was already absent, so callers can detect a no-op merge and
 * skip a needless `omp config set` call entirely. Exported for direct unit testing. */
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
  const result = await run(['config', 'get', 'modelRoles', '--json'], 'Could not read model roles from omp.', envOverride);
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
 * rejected chain link. Exported for direct unit testing of the serialisation guarantee itself,
 * independent of the real `omp` CLI timing. */
export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const chained = writeChain.then(task, task);
  writeChain = chained.then(
    () => undefined,
    () => undefined
  );
  return chained;
}

// Quality-gate remediation (code-reviewer/security-auditor LOW): widened past C0 controls and DEL
// to also cover C1 controls (U+0080-U+009F), the line/paragraph separators (U+2028/U+2029), and
// the bidi/zero-width/BOM range (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF) -- all of
// these can still be written into the global YAML by a compromised renderer (the ordinary
// catalog-only picker never produces them) and could render misleadingly elsewhere.
// eslint-disable-next-line no-control-regex -- deliberately matching control/format characters.
const SELECTOR_FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/** Exported for direct unit testing. */
export function assertValidSelector(value: string): void {
  if (value.trim().length === 0) {
    throw new OmpConfigError('invalid-value', 'Model selector cannot be blank.');
  }
  if (value.length > MAX_ROLE_VALUE_LENGTH) {
    throw new OmpConfigError('invalid-value', `Model selector is too long (max ${MAX_ROLE_VALUE_LENGTH} characters).`);
  }
  if (SELECTOR_FORBIDDEN_CHARS_RE.test(value)) {
    throw new OmpConfigError('invalid-value', 'Model selector contains control or formatting characters.');
  }
}

/** Sets or clears one role. `value: null` clears the role (deletes the key from the record)
 * rather than writing a JSON `null`: a project `modelRoles` tombstone is a `settings.ts` API
 * concept (`setProjectModelRole`/`clearProjectModelRole`), not something this CLI surface exposes,
 * and `set` only ever writes the global layer regardless (see module header -- now also confirmed
 * live even with `modelRoleStorage: project` set, FINDINGS item 48). Validates the selector shape
 * before ever entering the write queue; defensive-validates the role name too (redundant with the
 * IPC layer's own `isModelRoleId` check, matching this codebase's established independent-second-
 * layer convention). */
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
  const current = await readModelRolesRaw(envWithoutRoleOverrides(process.env));
  const next = mergeModelRole(current, role, value);
  if (next === current) {
    // Clearing an already-unset role: nothing changed, so skip the `omp config set` call
    // entirely (see `mergeModelRole`'s own comment).
    return { roles: stringEntriesOnly(current) };
  }
  const result = await run(
    ['config', 'set', 'modelRoles', JSON.stringify(next), '--json'],
    'Could not save the model role to omp.',
    envWithoutRoleOverrides(process.env)
  );
  const parsed = parseJson<OmpConfigSetJson>(result.stdout);
  // Quality-gate remediation (code-reviewer LOW: "the write path and the load path show different
  // values"): always re-read the TRUE effective record after a successful write (full
  // environment, the same as `getModelRoles()`), rather than trusting `parsed.value`/`next` --
  // this keeps what the UI shows right after a save consistent with what a later `load()` would
  // show, and also covers `omp config set --json` ever omitting `value` entirely (never returns
  // `{}` in that case).
  const roles = await getModelRoles();
  return {
    roles,
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
  const result = await run(['models', '--kind', kind, '--json'], 'Could not read the model catalog from omp.');
  const parsed = parseJson<unknown>(result.stdout);
  return parseCatalogResponse(parsed);
}
