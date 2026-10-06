// Holds `updateState.json` (data-model.md "UpdateState"): the spec.md Key Entity "Update"
// (notified -> downloaded and checksum-verified -> installed), persisted so it survives a crash
// or an unexpected shutdown between steps (edge case: "resumes the next time Refract quits").
// Same atomic-write helper and per-file-queue discipline as `registry.json`/`settings.json`
// (`src/main/store/atomicJson.ts`).

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { UpdateState } from '../../shared/ipc'

const VALID_PHASES: ReadonlySet<UpdateState['phase']> = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'failed'
])
const VALID_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(['not-installed', 'not-signed-in', 'offline'])

function defaultUpdateState(): UpdateState {
  return { version: 1, phase: 'idle' }
}

/** Quality-gate remediation (Medium "UpdateStateStore.open has no shape validation"):
 * `readJsonFile`'s generic `<T>` cast trusts whatever JSON happens to parse, including a file
 * hand-edited or left over from an older/incompatible build (a `phase` string outside the known
 * enum, a non-string `installerPath`, ...). This is the one place that distrusts the parsed
 * value before it ever becomes this store's in-memory state. */
function isValidUpdateState(value: unknown): value is UpdateState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v['version'] !== 1) return false
  if (typeof v['phase'] !== 'string' || !VALID_PHASES.has(v['phase'] as UpdateState['phase'])) return false
  if (v['installerPath'] !== undefined && typeof v['installerPath'] !== 'string') return false
  if (v['availableVersion'] !== undefined && typeof v['availableVersion'] !== 'string') return false
  if (v['notesUrl'] !== undefined && typeof v['notesUrl'] !== 'string') return false
  if (v['lastCheckedAt'] !== undefined && typeof v['lastCheckedAt'] !== 'string') return false
  if (v['lastError'] !== undefined && typeof v['lastError'] !== 'string') return false
  if (v['unavailableReason'] !== undefined && !VALID_UNAVAILABLE_REASONS.has(v['unavailableReason'] as string)) return false
  return true
}

type UpdateStateListener = (state: UpdateState) => void

export class UpdateStateStore {
  private readonly listeners = new Set<UpdateStateListener>()

  private constructor(
    private readonly file: string,
    private data: UpdateState
  ) {}

  /** Quality-gate remediation (Medium): falls back to `defaultUpdateState()` on ANY read or parse
   * problem -- `readJsonFile` already quarantines a file that fails to `JSON.parse`, but a
   * different read error (e.g. a permission problem) used to propagate past this function
   * uncaught; it is now caught here too, same as the shape-validation fallback right below it.
   * `src/main/index.ts`'s own startup chain still wraps this call in a try/catch as a second,
   * outer safety net (quality-gate remediation, Medium "UpdateStateStore.open ... run unguarded
   * in the async whenReady chain"). */
  static async open(dir: string): Promise<UpdateStateStore> {
    const file = path.join(dir, 'updateState.json')
    let data: unknown
    try {
      data = await readJsonFile<UpdateState>(file, defaultUpdateState)
    } catch (err) {
      console.error('UpdateStateStore: failed to read updateState.json; falling back to defaults', err)
      data = defaultUpdateState()
    }
    return new UpdateStateStore(file, isValidUpdateState(data) ? data : defaultUpdateState())
  }

  /** A pure in-memory fallback for the rare case `open()` itself cannot even be attempted (its own
   * try/catch above already absorbs every realistic read/parse failure) -- `src/main/index.ts`'s
   * outer try/catch uses this so the startup chain always has a working store to hand to
   * `registerIpc`/`registerUpdates`, and the window still opens. Never reads or writes
   * `updateState.json` itself before its first real `.update()` call. */
  static inMemory(dir: string): UpdateStateStore {
    return new UpdateStateStore(path.join(dir, 'updateState.json'), defaultUpdateState())
  }

  get(): UpdateState {
    return { ...this.data }
  }

  /** Every caller-facing module (`UpdateChecker`, `UpdateInstaller`, `installOnQuit`, main's own
   * startup resolution) patches only the fields it owns for that transition; a key omitted from
   * `patch` keeps its current value, a key explicitly set to `undefined` clears it (the same
   * `JSON.stringify` drops `undefined` convention `SettingsStore`'s `rawTheme` already relies on)
   * -- e.g. `lastError: undefined` on the next successful phase transition (data-model.md).
   * Every listener registered via `onChange` (`ipc/updates.ts`'s `updates:state-changed`
   * broadcast) fires once per persisted transition, including the ones made mid-download for a
   * live progress indicator (contracts/ipc.md). */
  async update(patch: Partial<Omit<UpdateState, 'version'>>): Promise<UpdateState> {
    const next: UpdateState = { ...this.data, ...patch, version: 1 }
    this.data = next
    await writeJsonFile(this.file, next)
    const value = { ...next }
    for (const listener of this.listeners) listener({ ...value })
    return value
  }

  /** Returns an unsubscribe function, the same `Unsubscribe` shape every IPC event subscription
   * in this app already uses (`src/shared/ipc.ts`). */
  onChange(listener: UpdateStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
