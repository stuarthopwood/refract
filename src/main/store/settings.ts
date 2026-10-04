// Holds `settings.json`: the single app-wide Settings row (data-model.md "settings.json").

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import { DEFAULT_SESSION_READOUT } from '../../shared/model'
import type { ApprovalMode, ReadoutKind, Settings, SplitLayout } from '../../shared/model'

export class SettingsStore {
  private constructor(
    private readonly file: string,
    private data: Settings
  ) {}

  static async open(dir: string): Promise<SettingsStore> {
    const file = path.join(dir, 'settings.json')
    const data = await readJsonFile<Settings>(file, () => ({ version: 1, approvalMode: 'ask', sessionReadout: DEFAULT_SESSION_READOUT, split: null }))
    // Spec 004 data-model.md "Migration": an existing settings.json written before this spec has
    // no `sessionReadout` key at all; this is a field-level merge under an otherwise-valid parsed
    // object, distinct from the full-default fallback `readJsonFile` already applies on a missing
    // or corrupt file above.
    if (!data.sessionReadout) {
      data.sessionReadout = DEFAULT_SESSION_READOUT
    }
    // Spec 005 data-model.md "Migration": an existing settings.json written before this spec has
    // no `split` key at all (`undefined`, not `null`); the same field-level merge pattern as
    // `sessionReadout` above.
    if (data.split === undefined) {
      data.split = null
    }
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

  /** `settings.setReadoutVisibility(kind, visible)` (spec 004 FR-012 to FR-014, contracts/ipc.md):
   * replaces one `sessionReadout` entry and persists the whole row, the same race-safety pattern
   * as `setApprovalMode` above (returns this call's own written value, never a possibly-superseded
   * shared read). */
  async setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<Settings> {
    const next = { ...this.data, sessionReadout: { ...this.data.sessionReadout, [kind]: visible } }
    this.data = next
    await writeJsonFile(this.file, next)
    return { ...next }
  }

  /** `settings.setSplit(layout)` (spec 005 FR-014/FR-015/data-model.md, contracts/ipc.md): persists
   * the whole Split layout (or `null` for no split), the same race-safety pattern as
   * `setApprovalMode`/`setReadoutVisibility` above (returns this call's own written value). Never
   * starts, stops, or touches any agent -- this call only ever writes the stored layout. */
  async setSplit(layout: SplitLayout | null): Promise<Settings> {
    const next = { ...this.data, split: layout }
    this.data = next
    await writeJsonFile(this.file, next)
    return { ...next }
  }
}
