// Holds `settings.json`: the single app-wide Settings row (data-model.md "settings.json").

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import { DEFAULT_SESSION_READOUT, DEFAULT_TRANSCRIPT_DISPLAY } from '../../shared/model'
import type { ApprovalMode, ReadoutKind, Settings, SplitLayout, TranscriptDisplaySettings } from '../../shared/model'
import { isThemeId } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'

// Quality-gate remediation (security-auditor, HIGH, independent of ipc/settings.ts's own
// validation): a hand-edited or already-corrupt settings.json bypasses the IPC handler entirely
// -- this is the second, independent layer, run every time the file is read, not just on a
// fresh write. Any shape mismatch (including the three-or-more-ids, duplicate-id, out-of-range
// percent, or non-0/1 focusedIndex cases a direct file edit could introduce) resets `split` to
// `null` rather than crashing `validateSplitAtStartup`'s later `.sessionIds.filter` call.
function isValidSplitLayout(value: unknown): value is SplitLayout {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { sessionIds, dividerPercent, focusedIndex } = value as Partial<SplitLayout>
  const first = Array.isArray(sessionIds) ? sessionIds[0] : undefined
  const second = Array.isArray(sessionIds) ? sessionIds[1] : undefined
  const validSessionIds = Array.isArray(sessionIds) && sessionIds.length === 2 && typeof first === 'string' && typeof second === 'string' && first !== second
  const validDividerPercent = typeof dividerPercent === 'number' && Number.isFinite(dividerPercent) && dividerPercent >= 0 && dividerPercent <= 100
  const validFocusedIndex = focusedIndex === 0 || focusedIndex === 1
  return validSessionIds && validDividerPercent && validFocusedIndex
}

export class SettingsStore {
  private constructor(
    private readonly file: string,
    private data: Settings,
    // Quality-gate remediation (HIGH): the exact, pre-correction `theme` value as it was
    // actually in settings.json (a real ThemeId once the developer has ever saved a theme
    // choice, otherwise `undefined` -- missing key or invalid/corrupt value, never trusted
    // here). Kept separate from `this.data.theme` (always the corrected, in-memory value
    // every reader needs) so an UNRELATED setter's own whole-row write below never silently
    // persists FR-013's in-memory correction to disk on the user's behalf -- only `setTheme`
    // itself, a real save, is allowed to turn this from `undefined`/stale into the new value.
    private rawTheme: ThemeId | undefined,
    // Spec 012: see `open`'s own comment above for why this must stay separate from
    // `this.data.watermarkEnabled`, the same reasoning as `rawTheme` immediately above.
    private rawWatermarkEnabled: boolean | undefined,
    // Spec 013 (T019, research.md decision 6): `showSampleData` is lazy-corrected the same way
    // as `watermarkEnabled` below (missing/non-boolean -> `false` in memory), so it needs the
    // same raw/corrected split for the same reason -- an unrelated setter's own whole-row write
    // must never silently persist this in-memory correction to disk.
    private rawShowSampleData: boolean | undefined
  ) {}

  static async open(dir: string): Promise<SettingsStore> {
    const file = path.join(dir, 'settings.json')
    const data = await readJsonFile<Settings>(file, () => ({ version: 1, approvalMode: 'ask', sessionReadout: DEFAULT_SESSION_READOUT, split: null, theme: 'dark', watermarkEnabled: true, transcriptDisplay: DEFAULT_TRANSCRIPT_DISPLAY, showSampleData: false, detectImagePathsOnPaste: true }))
    // Spec 004 data-model.md "Migration": an existing settings.json written before this spec has
    // no `sessionReadout` key at all; this is a field-level merge under an otherwise-valid parsed
    // object, distinct from the full-default fallback `readJsonFile` already applies on a missing
    // or corrupt file above.
    if (!data.sessionReadout) {
      data.sessionReadout = DEFAULT_SESSION_READOUT
    }
    // Spec 005 data-model.md "Migration": an existing settings.json written before this spec has
    // no `split` key at all (`undefined`, not `null`); the same field-level merge pattern as
    // `sessionReadout` above. A present-but-malformed value (hand-edited, or from a future/older
    // build) is reset to `null` rather than trusted -- see `isValidSplitLayout`'s own comment.
    if (data.split !== null && !isValidSplitLayout(data.split)) {
      data.split = null
    }
    // Spec 007 data-model.md "Extended Settings", FR-013: an existing settings.json written
    // before this spec has no `theme` key at all (the same missing-key migration as
    // `sessionReadout`/`split` above), and a value that IS present but is not a key of `THEMES`
    // (a theme a later app update removed) is treated as the default preset for every read --
    // the bootstrap read, the picker's marked entry, and `theme-store.ts`'s derivation -- without
    // requiring a save; the same lazy-correction pattern `isValidSplitLayout` above already uses
    // for `split`. (Quality-gate remediation, round 2: this previously claimed the correction
    // 'does not rewrite the file until the developer actually saves a theme choice' -- not quite
    // true. An UNRELATED setter's own whole-row write (`persistWhole` below) still rewrites the
    // whole file immediately; it just writes `rawTheme`, so the missing/invalid key is silently
    // DROPPED from the file on that save rather than being corrected into it -- same practical
    // end state the old wording described, reached a different way.)
    //
    // Quality-gate remediation (HIGH): `rawTheme` captures the value exactly as it was BEFORE
    // this correction -- `undefined` for both the "missing key" and "present but invalid" cases
    // -- so the correction below only ever changes what `this.data.theme` (and so every reader)
    // sees in memory; see the constructor's own comment for why the two must stay separate.
    const rawTheme = isThemeId(data.theme) ? data.theme : undefined
    if (!isThemeId(data.theme)) {
      data.theme = 'dark'
    }
    // Spec 012 data-model.md "Migration"/"Validation" (FR-019/FR-020): an existing settings.json
    // written before this spec has no `watermarkEnabled` key at all (`undefined`), and a present
    // but non-boolean value (hand-edited/corrupt) is treated the same way -- both fall back to
    // `true` in memory here, the same lazy-correction pattern as `theme`/`split` above.
    // `rawWatermarkEnabled` mirrors `rawTheme`'s own race-safety split: the exact, pre-correction
    // value as it was actually on disk (a real boolean once the developer has ever saved a
    // choice, otherwise `undefined`), kept separate from `this.data.watermarkEnabled` (always the
    // corrected, in-memory value every reader needs) so an UNRELATED setter's own whole-row write
    // never silently persists this in-memory correction to disk on the user's behalf -- only
    // `setWatermarkEnabled` itself, a real save, is allowed to turn this from `undefined`/stale
    // into the new value.
    const rawWatermarkEnabled = typeof data.watermarkEnabled === 'boolean' ? data.watermarkEnabled : undefined
    if (typeof data.watermarkEnabled !== 'boolean') {
      data.watermarkEnabled = true
    }
    // Issue #457 data-model: an existing settings.json written before this issue has no
    // `transcriptDisplay` key at all (or an invalid/corrupt shape) -- the same field-level
    // migration pattern `sessionReadout`/`split` above already use (lazy in-memory correction,
    // no raw-tracking dance since this is a plain immediate-apply toggle pair, not a
    // Save/Cancel-previewed field like `theme`/`watermarkEnabled`). Quality-gate fix (code
    // review/security-auditor, Low): per FIELD, not per object -- a hand-edited
    // `{thinking: false, toolCalls: "no"}` keeps the valid `thinking: false` choice instead of
    // resetting it back to `true` just because the sibling field is invalid. Rebuilt from
    // exactly these two keys either way, so a stray/extra key (including an own `__proto__` data
    // property `JSON.parse` could produce) never survives into memory or a later re-save.
    const rawTranscriptDisplay = data.transcriptDisplay as Partial<TranscriptDisplaySettings> | null | undefined
    data.transcriptDisplay = {
      thinking: typeof rawTranscriptDisplay?.thinking === 'boolean' ? rawTranscriptDisplay.thinking : true,
      toolCalls: typeof rawTranscriptDisplay?.toolCalls === 'boolean' ? rawTranscriptDisplay.toolCalls : true
    }
    // Spec 013 data-model.md "Migration" (T019): an existing settings.json written before this
    // spec has no `showSampleData` key at all, and a present but non-boolean value (hand-edited/
    // corrupt) is treated the same way -- both fall back to `false` in memory, the same
    // lazy-correction pattern as `theme`/`split`/`watermarkEnabled` above. `rawShowSampleData`
    // mirrors `rawWatermarkEnabled`'s own race-safety split (see the constructor's comment).
    const rawShowSampleData = typeof data.showSampleData === 'boolean' ? data.showSampleData : undefined
    if (typeof data.showSampleData !== 'boolean') {
      data.showSampleData = false
    }
    // #514 data-model: an existing settings.json written before this issue has no
    // `detectImagePathsOnPaste` key at all (or a non-boolean value) -- the same plain
    // lazy-in-memory-correction pattern `transcriptDisplay` above already uses (no raw-tracking
    // dance needed: a plain immediate-apply toggle, not a Save/Cancel-previewed field).
    if (typeof data.detectImagePathsOnPaste !== 'boolean') {
      data.detectImagePathsOnPaste = true
    }
    return new SettingsStore(file, data, rawTheme, rawWatermarkEnabled, rawShowSampleData)
  }

  get(): Settings {
    return { ...this.data }
  }

  // Quality-gate remediation (HIGH): every setter below that persists the WHOLE row (every one
  // except `setTheme` itself) must write `rawTheme` -- the value exactly as it was last actually
  // on disk, not `this.data.theme`'s possibly FR-013-corrected in-memory value -- so an unrelated
  // save (approval mode, readout visibility, split) never silently writes that correction to
  // settings.json on the user's behalf. `JSON.stringify` drops an `undefined` value entirely, so
  // `rawTheme === undefined` naturally reproduces "no theme key written yet" on disk, exactly
  // matching the pre-existing migration/lazy-correction comments above.
  //
  // Quality-gate remediation (round 2, Medium): the same reasoning applies to
  // `rawWatermarkEnabled` -- `setTheme` below used to write `next` (the in-memory, possibly
  // FR-019/FR-020-corrected `watermarkEnabled`) straight to disk, silently persisting that
  // correction on an unrelated theme save. `serialize` is now the one place every writer in this
  // class builds its on-disk row from, so `setTheme` (which must write its OWN just-updated
  // `rawTheme`, unlike every other setter) and `persistWhole` (which writes the OLD `rawTheme`/
  // `rawWatermarkEnabled`/`rawShowSampleData`) can never again drift apart on this. Spec 013
  // (T019) added `rawShowSampleData` to this same list for the identical reason (research.md
  // decision 6).
  private serialize(next: Settings): Settings {
    return {
      ...next,
      theme: this.rawTheme as ThemeId,
      watermarkEnabled: this.rawWatermarkEnabled as boolean,
      showSampleData: this.rawShowSampleData as boolean
    }
  }

  private async persistWhole(next: Settings): Promise<Settings> {
    this.data = next
    await writeJsonFile(this.file, this.serialize(next))
    return { ...next }
  }

  async setApprovalMode(mode: ApprovalMode): Promise<Settings> {
    const next = { ...this.data, approvalMode: mode }
    // Return this call's own written value, not `this.get()`: a concurrent caller's later
    // `setApprovalMode` may already have overwritten the shared `this.data` by the time this
    // write's promise resolves, which would otherwise hand every racing caller the same
    // (wrong, most-recent) mode instead of the one it actually asked to set -- and
    // `ipc/settings.ts` feeds that value straight into `applyPendingModeChange`, so a stale
    // read there could launch a live Session in someone else's requested mode.
    return this.persistWhole(next)
  }

  /** `settings.setReadoutVisibility(kind, visible)` (spec 004 FR-012 to FR-014, contracts/ipc.md):
   * replaces one `sessionReadout` entry and persists the whole row, the same race-safety pattern
   * as `setApprovalMode` above (returns this call's own written value, never a possibly-superseded
   * shared read). */
  async setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<Settings> {
    const next = { ...this.data, sessionReadout: { ...this.data.sessionReadout, [kind]: visible } }
    return this.persistWhole(next)
  }

  /** `settings.setSplit(layout)` (spec 005 FR-014/FR-015/data-model.md, contracts/ipc.md): persists
   * the whole Split layout (or `null` for no split), the same race-safety pattern as
   * `setApprovalMode`/`setReadoutVisibility` above (returns this call's own written value). Never
   * starts, stops, or touches any agent -- this call only ever writes the stored layout. */
  async setSplit(layout: SplitLayout | null): Promise<Settings> {
    const next = { ...this.data, split: layout }
    return this.persistWhole(next)
  }

  /** `theme.set(themeId)` (spec 007 FR-004, contracts/ipc.md): persists the chosen theme as the
   * one Refract starts in and follows afterwards, the same race-safety pattern as every setter
   * above (returns this call's own written value, never a possibly-superseded shared read). The
   * caller (`src/main/ipc/theme.ts`) validates `themeId` against `THEMES` before calling this --
   * this method trusts it, same division of responsibility as `setApprovalMode`/`APPROVAL_MODES`. */
  async setTheme(themeId: ThemeId): Promise<Settings> {
    const next = { ...this.data, theme: themeId }
    this.data = next
    // The one and only place allowed to turn `rawTheme` into a real, developer-saved value --
    // every other setter above goes through `persistWhole`, which deliberately writes the OLD
    // `rawTheme` back, not this new one, until this method itself runs. `serialize` still writes
    // `rawWatermarkEnabled`/`rawShowSampleData` (both unchanged by this call) rather than
    // `next.watermarkEnabled`/`next.showSampleData`, so an in-memory FR-019/FR-020 correction
    // never rides along on an unrelated theme save.
    this.rawTheme = themeId
    await writeJsonFile(this.file, this.serialize(next))
    return { ...next }
  }

  /** `settings.setWatermarkEnabled(enabled)` (spec 012 FR-015 to FR-020, contracts/ipc.md):
   * persists the whole row via `persistWhole`, the same race-safety pattern as `setApprovalMode`/
   * `setReadoutVisibility`/`setSplit` above (returns this call's own written value, never a
   * possibly-superseded shared read). The one and only place allowed to turn
   * `rawWatermarkEnabled` into a real, developer-saved value -- every other setter's own call to
   * `persistWhole` deliberately writes the OLD `rawWatermarkEnabled` back, not any lazily-
   * corrected in-memory value, until this method itself runs (mirrors `setTheme`'s own `rawTheme`
   * handling, data-model.md "Validation"). */
  async setWatermarkEnabled(enabled: boolean): Promise<Settings> {
    this.rawWatermarkEnabled = enabled
    const next = { ...this.data, watermarkEnabled: enabled }
    return this.persistWhole(next)
  }

  /** `settings.setTranscriptDisplay(field, visible)` (issue #457, quality-gate remediation
   * HIGH: the original whole-object write let a quick second toggle (sent with the stale
   * render-time value of the first field) silently revert it mid-flight). Merges ONE field
   * into `this.data.transcriptDisplay` and persists the whole row via `persistWhole`, the same
   * per-field pattern `setReadoutVisibility` already uses for its own record-shaped setting,
   * and the same race-safety pattern as every setter above (returns this call's own written
   * value, never a possibly-superseded shared read). No raw/lazy-correction tracking needed
   * (unlike `theme`/`watermarkEnabled`): this is a plain immediate-apply toggle pair, the same
   * migration shape as `sessionReadout`/`split` above, not a Save/Cancel-previewed field. */
  async setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<Settings> {
    // Quality-gate fix (security-auditor, Low): rebuilt from exactly the two known keys (never a
    // `...this.data.transcriptDisplay` spread of the possibly-already-clean object), so this
    // setter can never itself be the path that writes a stray key back to disk.
    const next = {
      ...this.data,
      transcriptDisplay: {
        thinking: this.data.transcriptDisplay.thinking,
        toolCalls: this.data.transcriptDisplay.toolCalls,
        [field]: visible
      }
    }
    return this.persistWhole(next)
  }

  /** `settings.setShowSampleData(enabled)` (spec 013 FR-020 to FR-022, contracts/ipc.md):
   * persists the whole row via `persistWhole`, the same race-safety pattern as every setter
   * above (returns this call's own written value, never a possibly-superseded shared read). The
   * one and only place allowed to turn `rawShowSampleData` into a real, developer-saved value --
   * every other setter's own call to `persistWhole` deliberately writes the OLD
   * `rawShowSampleData` back, not any lazily-corrected in-memory value, until this method itself
   * runs (mirrors `setWatermarkEnabled`'s own handling above). */
  async setShowSampleData(enabled: boolean): Promise<Settings> {
    this.rawShowSampleData = enabled
    const next = { ...this.data, showSampleData: enabled }
    return this.persistWhole(next)
  }

  /** `settings.setDetectImagePathsOnPaste(enabled)` (#514, contracts/ipc.md): persists the whole
   * row via `persistWhole`, the same race-safety pattern as every setter above (returns this
   * call's own written value, never a possibly-superseded shared read). No raw/lazy-correction
   * tracking needed -- the same plain-boolean migration shape `setTranscriptDisplay` above uses. */
  async setDetectImagePathsOnPaste(enabled: boolean): Promise<Settings> {
    const next = { ...this.data, detectImagePathsOnPaste: enabled }
    return this.persistWhole(next)
  }
}
