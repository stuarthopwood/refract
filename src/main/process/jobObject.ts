// Windows-only process containment: joins Refract's own process to a Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so every child `omp` process (and its own descendants,
// since Job Object membership is inherited) is force-killed by Windows itself if Refract's main
// process dies or is killed, without Refract having to track and clean up every descendant pid.
//
// This is the ONLY file in the codebase that touches Windows FFI (koffi / kernel32.dll). Struct
// layout and offsets are copied from the verified spike probe at docs/spike/job-object-probe.mjs.

import * as os from 'node:os'
import koffi from 'koffi'

export interface JoinJobResult {
  ok: boolean
  error?: string
}

// Cached across calls: joinKillOnCloseJob is idempotent, and the job handle is kept referenced
// here for the lifetime of the process. If it were allowed to become garbage, koffi could close
// the underlying HANDLE and the kill-on-close guarantee would be lost silently.
let cachedResult: JoinJobResult | undefined
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque koffi pointer, kept alive only
let jobHandle: unknown

export function joinKillOnCloseJob(): JoinJobResult {
  if (cachedResult) return cachedResult

  if (os.platform() !== 'win32') {
    cachedResult = { ok: false, error: 'not windows' }
    return cachedResult
  }

  try {
    const k32 = koffi.load('kernel32.dll')
    const CreateJobObjectW = k32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'void *'])
    const SetInformationJobObject = k32.func('__stdcall', 'SetInformationJobObject', 'int', [
      'void *',
      'int',
      'void *',
      'uint32'
    ])
    const AssignProcessToJobObject = k32.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *'])
    const GetCurrentProcess = k32.func('__stdcall', 'GetCurrentProcess', 'void *', [])
    const GetLastError = k32.func('__stdcall', 'GetLastError', 'uint32', [])

    const hJob = CreateJobObjectW(null, null)
    if (!hJob) {
      cachedResult = { ok: false, error: `CreateJobObjectW failed, GetLastError=${GetLastError()}` }
      return cachedResult
    }

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64: 144 bytes; BasicLimitInformation.LimitFlags
    // (DWORD) sits at offset 16. Verified against a live kill in docs/spike/job-object-probe.mjs.
    const buf = Buffer.alloc(144)
    buf.writeUInt32LE(0x2000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    const setOk = SetInformationJobObject(hJob, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buf, buf.length)
    if (!setOk) {
      cachedResult = { ok: false, error: `SetInformationJobObject failed, GetLastError=${GetLastError()}` }
      return cachedResult
    }

    const hSelf = GetCurrentProcess()
    const assignOk = AssignProcessToJobObject(hJob, hSelf)
    if (!assignOk) {
      cachedResult = { ok: false, error: `AssignProcessToJobObject failed, GetLastError=${GetLastError()}` }
      return cachedResult
    }

    jobHandle = hJob
    cachedResult = { ok: true }
    return cachedResult
  } catch (err) {
    cachedResult = { ok: false, error: err instanceof Error ? err.message : String(err) }
    return cachedResult
  }
}
