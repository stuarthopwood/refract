// Shared-cargo-cache helpers for `pnpm cache:sweep` and the `pnpm ci:local` size warning (#1736).
import { closeSync, openSync, readSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const CACHE_WARN_BYTES = 10 * 2 ** 30;

/** Total bytes of regular files under `dir`; symlinks are counted as links, never followed.
 *  With `limit`, stops walking once the running total exceeds it (the result is then a lower bound). */
export function dirSizeBytes(dir, limit = Infinity) {
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
          if (total > limit) return total;
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

/** Cargo holds an OS file lock on these files for the whole of a build. Only Windows enforces it
 *  (mandatory lock: a 1-byte read fails); on Linux/macOS flock is advisory so the read succeeds and
 *  this never reports a lock. Read-only, so it never disturbs cargo. */
function isLocked(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    return err.code !== 'ENOENT'; // unknown open failure: fail safe as locked
  }
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (err) {
    return err.code !== 'ENOENT';
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
