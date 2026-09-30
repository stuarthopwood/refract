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
    this.data = { ...this.data, approvalMode: mode }
    await writeJsonFile(this.file, this.data)
    return this.get()
  }
}
