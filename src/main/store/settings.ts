// Holds `settings.json`: the single app-wide Settings row (data-model.md "settings.json").

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { ApprovalMode, Settings } from '../../shared/model'

export class SettingsStore {
  private constructor(
    private readonly file: string,
    private data: Settings
  ) {}

  static async open(dir: string): Promise<SettingsStore> {
    const file = path.join(dir, 'settings.json')
    const data = await readJsonFile<Settings>(file, () => ({ version: 1, approvalMode: 'ask' }))
    return new SettingsStore(file, data)
  }

  get(): Settings {
    return { ...this.data }
  }

  async setApprovalMode(mode: ApprovalMode): Promise<Settings> {
    const next = { ...this.data, approvalMode: mode }
    this.data = next
    await writeJsonFile(this.file, next)
    // Return this call's own written value, not `this.get()`: a concurrent caller's later
    // `setApprovalMode` may already have overwritten the shared `this.data` by the time this
    // write's promise resolves, which would otherwise hand every racing caller the same
    // (wrong, most-recent) mode instead of the one it actually asked to set -- and
    // `ipc/settings.ts` feeds that value straight into `applyPendingModeChange`, so a stale
    // read there could launch a live Session in someone else's requested mode.
    return { ...next }
  }
}
