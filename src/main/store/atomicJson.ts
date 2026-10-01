// Atomic JSON file store: write-then-rename so a crash never leaves a torn file, and a file
// that fails to parse is quarantined instead of blocking launch (data-model.md "Stored by
// Refract").

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

// Per-file write queues (keyed by the resolved, lowercase path so two different-cased spellings
// of the same file still serialise together): two near-simultaneous writers to the same JSON
// file must never race on the shared `<name>.json.tmp` name (one's rename finding the other's
// tmp file already gone -> ENOENT). Every writer also gets its own unique temp filename, so even
// an unrelated caller bypassing this queue (there is none today) could not collide with it.
const writeQueues = new Map<string, Promise<unknown>>()
let tempCounter = 0

function enqueueWrite<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file).toLowerCase()
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const result = previous.then(task, task)
  writeQueues.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

/**
 * Writes `value` to `file` atomically: serialise to a uniquely-named `<name>.json.<pid>.<n>.tmp`,
 * flush it to disk, then rename over `<name>.json`. `rename` on the same volume is atomic, so
 * readers never see a partially written file. Concurrent calls for the same `file` are queued so
 * the file always ends up with the last-written value, never a rename racing a sibling call's
 * already-renamed-away temp file.
 */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  return enqueueWrite(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${++tempCounter}.tmp`
    const data = JSON.stringify(value, null, 2)
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
  })
}

/** Type guard so callers can narrow a caught value to a filesystem error and branch on `.code`. */
export function isEnoent(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null) return false
  return 'code' in err && err.code === 'ENOENT'
}
