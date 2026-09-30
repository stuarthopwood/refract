// Atomic JSON file store: write-then-rename so a crash never leaves a torn file, and a file
// that fails to parse is quarantined instead of blocking launch (data-model.md "Stored by
// Pinion").

import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Reads and parses `file`. A missing file returns `makeDefault()`. A file that exists but fails
 * to parse is renamed to `<name>.json.corrupt-<timestamp>` and `makeDefault()` is returned, so a
 * bad file never blocks launch.
 */
export async function readJsonFile<T>(file: string, makeDefault: () => T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return makeDefault()
    throw err
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    const corruptPath = `${file}.corrupt-${Date.now()}`
    try {
      await fs.rename(file, corruptPath)
    } catch {
      // Best effort: even if the quarantine rename fails, still fall back to a fresh default
      // rather than let a corrupt file block startup.
    }
    return makeDefault()
  }
}

/**
 * Writes `value` to `file` atomically: serialise to `<name>.json.tmp`, flush it to disk, then
 * rename over `<name>.json`. `rename` on the same volume is atomic, so readers never see a
 * partially written file.
 */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const data = JSON.stringify(value, null, 2)
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
}

/** Type guard so callers can narrow a caught value to a filesystem error and branch on `.code`. */
export function isEnoent(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null) return false
  return 'code' in err && err.code === 'ENOENT'
}
