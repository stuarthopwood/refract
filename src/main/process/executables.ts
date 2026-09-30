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

/** PATH entries only, in order; never `process.cwd()` or any spawn's `cwd`. */
function pathDirectories(): string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? '';
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
 * successful resolution (a fresh install replacing the binary mid-run is not a case Pinion needs
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
  throw new Error(`Could not resolve "${name}" on PATH. Install it and make sure it is on PATH, then relaunch Pinion.`);
}

/** `%SystemRoot%\System32\taskkill.exe`: a fixed system path, never a PATH/cwd search. */
export function taskkillPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'taskkill.exe');
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
