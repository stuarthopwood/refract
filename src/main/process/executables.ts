// Resolves executables to absolute paths by searching PATH ourselves, never the spawned
// process's cwd. Windows' `CreateProcess`/`cmd.exe` search order checks the current directory
// before PATH for a bare executable name, so a repository that commits e.g. `git.exe` or
// `omp.exe` at its root would otherwise run on `repositories.add` / `sessions.open` (found by an
// independent security review, reproduced on Node 26). Every spawn in this app must use an
// absolute path resolved here (or the fixed system paths below) instead of a bare name.

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

const cache = new Map<string, string>();

/** PATH entries only, in order; never `process.cwd()` or any spawn's `cwd`. Relative entries (`.`,
 * `bin`) are dropped: joined with a bare name they would resolve against the spawn's cwd, which is
 * the repository or worktree and is exactly the lookup this module exists to prevent. */
function pathDirectories(): string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? '';
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

function candidateExtensions(): string[] {
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  return extensions.length > 0 ? extensions : ['.EXE'];
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches PATH for `name`, honouring PATHEXT when `name` has no extension of its own. Caches a
 * successful resolution (a fresh install replacing the binary mid-run is not a case Refract needs
 * to handle). Throws a clear `Error` if nothing is found; callers must not fall back to the bare
 * name.
 */
export async function resolveExecutable(name: string): Promise<string> {
  const cacheKey = name.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const hasExtension = path.extname(name).length > 0;
  const candidateNames = hasExtension ? [name] : candidateExtensions().map((ext) => `${name}${ext}`);

  for (const dir of pathDirectories()) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (await fileExists(candidate)) {
        cache.set(cacheKey, candidate);
        return candidate;
      }
    }
  }
  throw new Error(`Could not resolve "${name}" on PATH. Install it and make sure it is on PATH, then relaunch Refract.`);
}

/** `%SystemRoot%\System32\taskkill.exe`: a fixed system path, never a PATH/cwd search. */
export function taskkillPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'taskkill.exe');
}

let vsCodeExecutableCache: string | undefined;

/** Clears the cached, previously-successful VS Code resolution (PR #671 gate round 4 fix,
 * Medium): a spawn can still fail asynchronously AFTER this cache was populated (VS Code
 * uninstalled or moved mid-run, `EACCES`, antivirus quarantine) -- without clearing it, every
 * later `openInVSCode` call would keep returning the same now-stale path and keep failing the
 * same way until a full app restart. Exported for `fileExplorer.ts`'s own `child.once('error',
 * ...)` handler to call. */
export function clearVSCodeExecutableCache(): void {
  vsCodeExecutableCache = undefined;
}

/**
 * Resolves VS Code's `Code.exe` by checking fixed known install roots directly, never via
 * `resolveExecutable('code')`/PATH. `code`'s own PATH entry is a `bin/` folder containing
 * `code.cmd`, a batch wrapper, not `Code.exe` (which lives in the parent install directory) --
 * resolving to `code.cmd` would recreate the exact problem issue://463 flags: Node's 2024
 * BatchBadBinary fix means a `.cmd` cannot be spawned without `shell: true`, and `shell: true`
 * risks argument injection via `& | ^ %` in a filename being passed as an argument
 * (research.md decision 1). Checks, in order: the default one-click per-user install under
 * `%LOCALAPPDATA%`, then the system installs under `%ProgramFiles%` and
 * `%ProgramFiles(x86)%`. Returns `undefined` (never throws) when none exist -- VS Code's absence
 * is an expected, normal state (FR-017's "VS Code not found" UI state), not an error condition a
 * caller needs to catch.
 *
 * Caches only a successful resolution, in a separate module-level variable from `resolveExecutable`'s
 * own PATH-search cache (that cache is keyed by bare name, not by "VS Code" specifically, and this
 * resolver never touches PATH at all). A negative result is deliberately NOT cached: the check is
 * three cheap `access()` calls, and caching "not found" forever would require a Refract restart
 * after a user installs VS Code mid-session to ever pick up the new install.
 */
export async function resolveVSCodeExecutable(): Promise<string | undefined> {
  if (vsCodeExecutableCache) return vsCodeExecutableCache;

  const roots = [
    process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined,
    process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Microsoft VS Code', 'Code.exe') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe') : undefined,
  ];

  for (const candidate of roots) {
    if (candidate && (await fileExists(candidate))) {
      vsCodeExecutableCache = candidate;
      return candidate;
    }
  }
  return undefined;
}

/** `pwsh` via PATH when installed, else the well-known Windows PowerShell 5.1 location. */
export async function resolvePowerShell(): Promise<string> {
  try {
    return await resolveExecutable('pwsh');
  } catch {
    const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
}
