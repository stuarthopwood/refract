// Issue #1067 (Stuart grill 2026-10-20): Enter on a blank composer sends the oldest queued
// follow-up, exactly as that chip's own "Send now" button would (FR-012, issue #540). Pure
// derivation only -- MessageInput.tsx owns the actual Enter-key wiring and reuses the existing
// `handleSendNow`/`inFlightChips` single-flight guard (so a fast double Enter can never
// double-send); this module only decides WHETHER the rule applies this render and WHICH chip it
// targets. Kept out of MessageInput.tsx: that file is at its `check:file-size` baseline cap
// (issue #806).
import type { AttachmentsState } from './attachments'
import type { DerivedChip } from './queuedChips'

export interface EnterSendsQueuedFollowUp {
  /** True only when Enter (no Shift, not composing -- the caller already gates those) should
   * steer the oldest queued follow-up instead of calling the ordinary `handleSend()`. */
  applies: boolean
  /** Defined whenever `applies` is true; undefined otherwise. */
  chip: DerivedChip | undefined
}

/**
 * `showSlashMenu` and a live ghost-text suggestion both take priority over this rule (the
 * issue's own edge cases): Enter must never be hijacked while either is showing. A ghost
 * suggestion can't actually coexist with a blank draft today (`isGhostTextEligible` requires
 * text already on the line), but the guard is kept explicit rather than relying on that
 * invariant holding forever.
 *
 * "Blank" per the issue: whitespace-only text, no pending images, text chips, or file
 * attachments. Deliberately NOT the `hasSendableContent` predicate issue #744 proposes (that one
 * treats an attachment-only draft as sendable); this is the opposite question -- "is there
 * nothing here a plain Enter could send as typed text".
 *
 * The oldest queued follow-up is the one a repeat Enter sends first, matching the first "Send
 * now" button a developer would see: `chips` lists every follow-up before any steering chip, in
 * `followUp` array order (FIFO, OMP's own `promote_queued_message`), so the first follow-up
 * occurrence in the list is always the oldest. Queued `steering` chips are skipped by the
 * `'followUp'` filter below: a session with only steering queued finds none here, matching the
 * issue's "steering-only queued, Enter does nothing" case.
 */
export function computeEnterSendsQueuedFollowUp(
  text: string,
  attachments: AttachmentsState,
  chips: readonly DerivedChip[],
  showSlashMenu: boolean,
  ghost: { text: string } | null
): EnterSendsQueuedFollowUp {
  const isBlank = text.trim() === '' && attachments.images.length === 0 && attachments.textChips.length === 0 && attachments.files.length === 0
  if (showSlashMenu || (ghost && ghost.text === text) || !isBlank) return { applies: false, chip: undefined }
  const chip = chips.find((c) => c.queue === 'followUp')
  return { applies: chip !== undefined, chip }
}
