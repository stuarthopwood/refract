// Reads and writes OMP model roles via the `omp config` CLI (issue #455). `omp config get
// modelRoles --json` returns the whole `modelRoles` record as ONE value -- dotted per-key access
// (`modelRoles.<role>`) returns "Unknown setting", confirmed live on omp 18.8.0
// (docs/spike/FINDINGS.md item 46j, docs/spike/probe-batch-18.8.0.mjs) -- so there is no cheaper
// single-role read or write. `omp config set modelRoles '<json>' --json` always writes the GLOBAL
// config.yml, never a project override (`omp://settings.md` "Where writes go": "Settings commands
// do not write arbitrary project keys"), which answers issue #455's own "which scope does Refract
// write" open question directly from the CLI's documented behaviour -- there is no project-scoped
// write path through this CLI surface at all. No `overriddenBy` field appears in `list`'s JSON
// (also probed); `set`'s own JSON response is where `overriddenBy` appears when a higher layer
// (an env var, `project`, `overlay`, or `runtime`) still wins despite the write succeeding.
//
// execFile only, no shell, an absolute resolved path (`resolveExecutable`, the same security
// discipline as `git/git.ts`/`github/gh.ts`: never a bare name Windows would resolve against the
// spawn's cwd before PATH), bounded stdout (`maxBuffer`), and a fixed role-name vocabulary
// (`isModelRoleId`) rather than arbitrary caller text reaching the argv.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { resolveExecutable } from '../process/executables';
import { isModelRoleId } from '../../shared/model';
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model';

const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1_048_576; // 1 MiB: bounded output, matching tool policy.

export type OmpConfigErrorCode = 'omp-not-found' | 'omp-failed' | 'timeout' | 'parse-failed';

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

// Model roles are a GLOBAL setting (never project-scoped by this module -- see header comment),
// so there is no repository path to run this in; the same reasoning `github/cli.ts`'s
// `ACCOUNT_CWD` gives for host/login-scoped `gh` commands.
const CONFIG_CWD = os.tmpdir();

/** Runs `omp <args>` with no shell in a neutral cwd. Mirrors `github/gh.ts`'s `ghRaw` discipline:
 * an `AbortController` timeout, an absolute resolved path, never throws for a nonzero exit --
 * callers branch on `.code`/`.timedOut`. Throws `OmpConfigError('omp-not-found', ...)` only when
 * `omp` itself cannot be found on PATH.
 *
 * Executor form (not `Promise.withResolvers()`): the same documented exception `github/gh.ts`'s
 * own `ghRaw` already carries -- `Promise.withResolvers()` needs lib "ES2024",
 * `tsconfig.node.json` is pinned to "ES2023". */
async function ompRaw(args: string[]): Promise<OmpRawResult> {
  let ompPath: string;
  try {
    ompPath = await resolveExecutable('omp');
  } catch {
    throw new OmpConfigError('omp-not-found', 'omp is not installed or not on PATH.');
  }
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    execFile(
      ompPath,
      args,
      { cwd: CONFIG_CWD, windowsHide: true, signal: controller.signal, maxBuffer: MAX_STDOUT_BYTES },
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
 * attaches raw stderr beyond a short, bounded slice to the thrown error's own message -- this is
 * the one place a credential-adjacent CLI failure text could otherwise leak into a log. */
async function run(args: string[], failureMessage: string): Promise<OmpRawResult> {
  const result = await ompRaw(args);
  if (result.timedOut) {
    throw new OmpConfigError('timeout', 'omp config timed out.');
  }
  if (result.code !== 0) {
    throw new OmpConfigError('omp-failed', result.stderr.trim().slice(0, 500) || failureMessage);
  }
  return result;
}

/** Generic CLI-JSON-output parse, matching `github/gh.ts`'s established `ghJson<T>` convention
 * for trusting a documented CLI's own `--json` shape. */
function parseJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new OmpConfigError('parse-failed', 'omp returned output that was not valid JSON.');
  }
}

interface OmpConfigGetJson {
  key: string;
  value: unknown;
  type: string;
  description?: string;
}

interface OmpConfigSetJson extends OmpConfigGetJson {
  overriddenBy?: string;
  fallbackEnv?: string;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OmpConfigError('parse-failed', 'omp config returned a non-record modelRoles value.');
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') record[key] = entry;
  }
  return record;
}

/** `omp config get modelRoles --json` (confirmed live, omp 18.8.0): the whole `modelRoles`
 * record in one call. A role absent from the returned record is unset (inherits its documented
 * fallback, e.g. `tiny` falls back to `@smol`). */
export async function getModelRoles(): Promise<Record<string, string>> {
  const result = await run(['config', 'get', 'modelRoles', '--json'], 'omp config get modelRoles failed.');
  const parsed = parseJson<OmpConfigGetJson>(result.stdout);
  return recordOfStrings(parsed.value);
}

export interface SetModelRoleResult {
  roles: Record<string, string>;
  /** Present when a higher-priority layer still supplies the effective value for the role just
   * written -- `omp config set`'s own documented `--json` field (`omp://settings.md`
   * "Subcommands"). */
  overriddenBy?: string;
}

/** Sets or clears one role by reading the whole `modelRoles` record, merging the one change, and
 * writing the whole record back with `omp config set modelRoles '<json>' --json`. `value: null`
 * clears the role (deletes the key from the record) rather than writing a JSON `null`: a project
 * `modelRoles` tombstone is a `settings.ts` API concept (`setProjectModelRole`/
 * `clearProjectModelRole`), not something this CLI surface exposes, and `set` only ever writes
 * the global layer regardless (see module header). */
export async function setModelRole(role: ModelRoleId, value: string | null): Promise<SetModelRoleResult> {
  if (!isModelRoleId(role)) {
    throw new OmpConfigError('parse-failed', `Unknown model role: ${String(role)}`);
  }
  const current = await getModelRoles();
  const next = { ...current };
  if (value === null) {
    delete next[role];
  } else {
    next[role] = value;
  }
  const result = await run(['config', 'set', 'modelRoles', JSON.stringify(next), '--json'], 'omp config set modelRoles failed.');
  const parsed = parseJson<OmpConfigSetJson>(result.stdout);
  return {
    roles: recordOfStrings(parsed.value),
    overriddenBy: typeof parsed.overriddenBy === 'string' ? parsed.overriddenBy : undefined,
  };
}

const CATALOG_KINDS: Record<string, true> = { chat: true, tiny: true, image: true, tts: true, stt: true, search: true, judge: true };

interface OmpModelsJson {
  models: unknown;
}

/** `omp models --kind <kind> --json` (`omp://models.md` "`/model` and `omp models`"): a read-only
 * catalog listing, independent of any live RPC session -- this is how the Role picker gets model
 * options without the Session-bound `get_available_models` RPC call, which FINDINGS item 21 found
 * carries no role field anyway and which lives behind `OmpProcess.ts`/`SessionAgent.ts` (Phase A
 * files this story does not touch). */
export async function listCatalogModels(kind: CatalogKind): Promise<ModelCatalogEntry[]> {
  if (!Object.prototype.hasOwnProperty.call(CATALOG_KINDS, kind)) {
    throw new OmpConfigError('parse-failed', `Unknown catalog kind: ${String(kind)}`);
  }
  const result = await run(['models', '--kind', kind, '--json'], 'omp models failed.');
  // Confirmed live (omp 18.8.0, both a fresh isolated profile with zero models and the real
  // signed-in profile): the array is wrapped in `{ models: [...] }`, never a bare top-level array.
  const parsed = parseJson<OmpModelsJson>(result.stdout);
  const rows = Array.isArray(parsed.models) ? parsed.models : [];
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
