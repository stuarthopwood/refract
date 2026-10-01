// Tracks pids of running `omp` root processes across an app restart, so a fresh Refract
// process can detect and force-kill processes orphaned by a previous crash before it starts
// spawning new ones. The Job Object in ./jobObject.ts is the primary line of defence (it kills
// every descendant the instant Refract's own process dies); this file is the fallback for the
// case where Refract itself was force-killed too abruptly for even that to run its course, or
// where the record simply predates a machine restart.
//
// No Windows FFI lives here (see jobObject.ts): process creation time, image name, and process
// termination all go through PowerShell (`Get-Process`, `taskkill`), which is more robust than
// wiring GetProcessTimes/QueryFullProcessImageName through koffi for this file's needs: it
// tolerates a pid that no longer exists without extra error-code plumbing, and it is the same
// mechanism already used to force-stop a Session's own omp process elsewhere in the app, so
// there is only one way pids get interrogated and killed by shell tooling in this codebase.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import type { ProcessRecord } from '../../shared/model'
import { readJsonFile, writeJsonFile } from '../store/atomicJson'
import { resolvePowerShell, taskkillPath } from './executables'

const execFileAsync = promisify(execFile)

function makeDefault(): ProcessRecord[] {
  return []
}

let filePath: string | undefined

// Every read-modify-write cycle (record/remove/reapStale) is chained onto this promise so
// concurrent calls serialise instead of racing on the same processes.json file.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export async function initPidRecords(userDataDir: string): Promise<void> {
  filePath = path.join(userDataDir, 'processes.json')
}

function requireFilePath(): string {
  if (!filePath) throw new Error('pidRecords not initialized; call initPidRecords first')
  return filePath
}

interface ProcessInfo {
  startTime: string
  imageName: string
}

/** A pid loaded from `processes.json` is untrusted file content; only a positive safe integer is
 * ever queried or passed to PowerShell/taskkill (security: never interpolate raw file content
 * into a shell command). */
function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
}

// Returns undefined when the pid is not currently running (already exited, or reused by a
// different process whose StartTime will differ from the caller's expectation anyway).
async function queryProcess(pid: number): Promise<ProcessInfo | undefined> {
  if (!isValidPid(pid)) return undefined
  const powerShellPath = await resolvePowerShell()
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.Name + '.exe' } else { '' }`
  const { stdout } = await execFileAsync(powerShellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true
  })
  const out = stdout.trim()
  if (!out) return undefined
  const sep = out.lastIndexOf('|')
  if (sep < 0) return undefined
  return { startTime: out.slice(0, sep), imageName: out.slice(sep + 1) }
}

export async function recordProcess(pid: number, sessionId: string): Promise<void> {
  const info = await queryProcess(pid)
  const startTime = info?.startTime ?? new Date().toISOString()
  await enqueue(async () => {
    const file = requireFilePath()
    const records = await readJsonFile<ProcessRecord[]>(file, makeDefault)
    const next = records.filter((r) => r.pid !== pid)
    next.push({ pid, startTime, sessionId })
    await writeJsonFile(file, next)
  })
}

export async function removeProcessRecord(pid: number): Promise<void> {
  await enqueue(async () => {
    const file = requireFilePath()
    const records = await readJsonFile<ProcessRecord[]>(file, makeDefault)
    const next = records.filter((r) => r.pid !== pid)
    await writeJsonFile(file, next)
  })
}

export async function reapStale(): Promise<number> {
  return enqueue(async () => {
    const file = requireFilePath()
    const records = await readJsonFile<ProcessRecord[]>(file, makeDefault)
    const taskkill = taskkillPath()
    let stopped = 0
    for (const record of records) {
      if (!isValidPid(record.pid)) continue
      const info = await queryProcess(record.pid)
      const isSameOmpProcess =
        info !== undefined && info.startTime === record.startTime && info.imageName.toLowerCase() === 'omp.exe'
      if (isSameOmpProcess) {
        try {
          await execFileAsync(taskkill, ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true })
          stopped += 1
        } catch {
          // Process exited between the query above and the kill attempt; nothing left to stop.
        }
      }
    }
    // Every record has now either been stopped or found stale/mismatched/invalid; none are worth
    // keeping across this reap.
    await writeJsonFile(file, makeDefault())
    return stopped
  })
}
