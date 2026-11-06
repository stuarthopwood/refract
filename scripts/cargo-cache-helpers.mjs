// Shared-cargo-cache helpers for `pnpm cache:sweep` and the `pnpm ci:local` size warning (#1736).
import { closeSync, openSync, readSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const CACHE_WARN_BYTES = 10 * 2 ** 30;

/** Total bytes of regular files under `dir`; symlinks are counted as links, never followed. */
export function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable mid-walk (another build is writing); a best-effort size is enough.
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += lstatSync(full).size;
        } catch {
          // deleted between readdir and stat
        }
      }
    }
  }
  return total;
}

export function formatGiB(bytes) {
  return `${(bytes / 2 ** 30).toFixed(2)} GB`;
}

const LOCK_NAMES = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];
const LOCK_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Cargo holds an OS file lock on these files for the whole of a build, and on Windows that lock
 *  is mandatory: a read of the locked range fails even on the empty file, so a failed 1-byte read
 *  means a build is in flight. Read-only, so it never disturbs cargo. */
function isLocked(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    return LOCK_ERRORS.has(err.code);
  }
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (err) {
    return LOCK_ERRORS.has(err.code);
  } finally {
    closeSync(fd);
  }
}

/** Lock files currently held under `targetDir`, checked at the root and in profile (`debug`) and
 *  target-triple/profile directories (up to two levels down). Empty means no build holds the cache. */
export function heldCargoLocks(targetDir) {
  const dirs = [targetDir];
  for (const level1 of safeSubdirs(targetDir)) {
    dirs.push(level1);
    dirs.push(...safeSubdirs(level1));
  }
  const held = [];
  for (const dir of dirs) {
    for (const name of LOCK_NAMES) {
      const file = path.join(dir, name);
      if (isLocked(file)) held.push(file);
    }
  }
  return held;
}

function safeSubdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}
