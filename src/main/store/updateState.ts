// Holds `updateState.json` (data-model.md "UpdateState"): the spec.md Key Entity "Update"
// (notified -> downloaded and checksum-verified -> installed), persisted so it survives a crash
// or an unexpected shutdown between steps (edge case: "resumes the next time Refract quits").
// Same atomic-write helper and per-file-queue discipline as `registry.json`/`settings.json`
// (`src/main/store/atomicJson.ts`).

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { UpdateState } from '../../shared/ipc'

function defaultUpdateState(): UpdateState {
  return { version: 1, phase: 'idle' }
}

type UpdateStateListener = (state: UpdateState) => void

export class UpdateStateStore {
  private readonly listeners = new Set<UpdateStateListener>()

  private constructor(
    private readonly file: string,
    private data: UpdateState
  ) {}

  static async open(dir: string): Promise<UpdateStateStore> {
    const file = path.join(dir, 'updateState.json')
    const data = await readJsonFile<UpdateState>(file, defaultUpdateState)
    return new UpdateStateStore(file, data)
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
