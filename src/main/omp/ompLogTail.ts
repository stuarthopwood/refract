// Locates and tails the per-process OMP log for a given pid (issue #512 requirement 2: "show
// the real reason" instead of a bare "ready frame not seen"). OMP writes one log file per
// process at `~/.omp/logs/omp.<date>.<pid>.log` (omp-usage.md "Logging"); this module finds the
// newest file whose name ends in `.<pid>.log` AND whose mtime is at or after the pid's own spawn
// time, then returns a bounded tail of it.
//
// Gate-fixes findings (security review): pids get reused quickly on Windows, so matching on name
// alone can return an unrelated older process's log, misattributing its content as "the real
// reason" for a different Session's failure -- `spawnedAtMs` guards against that. The whole file
// used to be read into memory just to keep the last few KiB (also wrong for a multi-megabyte
// log, read right when memory may already be low); `readTail` now reads only the bytes it needs.
//
// Gate-fixes security Low finding (cycle 5): `lstat` (not `stat`) and an explicit `isFile()`
// check, in both the mtime lookup and the read -- `stat`/`open` alone follow symlinks, so a
// symlink named `omp.x.<pid>.log` planted in `~/.omp/logs` would otherwise let this read and
// display the tail of any file the user can read (defence in depth only: planting it already
// requires the user's own privileges).

import { lstat, open, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LOGS_DIR = path.join(os.homedir(), '.omp', 'logs')

/** The file's last-modified time (epoch ms), or `undefined` if it cannot be stat'd, is a
 * symlink, or is not a regular file. */
async function statMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile()) return undefined
    return info.mtimeMs
  } catch {
    return undefined
  }
}

/** Reads at most the last `maxBytes` bytes of the file (from `size - maxBytes`, or the whole
 * file if it is smaller), decoded as UTF-8 with a non-fatal decoder so a multi-byte character
 * split by the cut is replaced rather than throwing. `undefined` on any read error, a symlink,
 * or anything that is not a regular file. */
async function readTail(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const info = await lstat(filePath)
    if (!info.isFile()) return undefined
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const length = Math.min(maxBytes, size)
    const position = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(length)
    // Gate-fixes security Low finding: `bytesRead` can be less than `length` on a short
    // read; decoding the whole (possibly zero-filled) buffer would otherwise turn the
    // unread remainder into NUL characters in the diagnostic.
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, bytesRead))
    // Gate-fixes security Low finding: `position > 0` means this cut the file mid-line, so
    // the first line here is a truncated fragment that may carry a credential's tail end
    // with no recognisable prefix left for `redactSecrets` to match. Dropped before the
    // caller ever redacts this text. Gate-fixes security/test Medium finding (cycle 3): a
    // truncated tail with NO newline at all (e.g. one very long single-line JSON log record)
    // used to return the whole fragment unchanged -- the entire tail is then the partial
    // line this rule exists to drop, so it returns empty instead of ever reaching
    // `redactSecrets` with no prefix left to match.
    if (position > 0) {
      const newlineIndex = decoded.indexOf('\n')
      return newlineIndex === -1 ? '' : decoded.slice(newlineIndex + 1)
    }
    return decoded
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Returns the tail of the newest log file matching `pid` whose mtime is at or after
 * `spawnedAtMs`, or `undefined` if no such file exists, the directory can't be read, or the file
 * can't be read (a missing `~/.omp/logs` is not itself a failure worth surfacing: the caller
 * already has a ready-wait failure to report, with or without a log tail attached). A file
 * matches when its name is `omp.<anything>.<pid>.log` (e.g. `omp.2026-10-07.36860.log`); when
 * more than one matches and is new enough, the one with the greatest mtime wins. */
export async function tailOmpLogForPid(pid: number, maxBytes: number, spawnedAtMs: number): Promise<string | undefined> {
  let fileNames: string[]
  try {
    fileNames = await readdir(LOGS_DIR)
  } catch {
    return undefined
  }

  const pattern = new RegExp(`^omp\\..+\\.${pid}\\.log$`)
  const candidates = fileNames.filter((name) => pattern.test(name))

  let newest: { name: string; mtimeMs: number } | undefined
  for (const name of candidates) {
    const mtimeMs = await statMtimeMs(path.join(LOGS_DIR, name))
    if (mtimeMs === undefined || mtimeMs < spawnedAtMs) continue
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs }
  }
  if (!newest) return undefined

  return readTail(path.join(LOGS_DIR, newest.name), maxBytes)
}
