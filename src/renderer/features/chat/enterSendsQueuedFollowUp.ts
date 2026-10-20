// Issue #1067 (Stuart grill 2026-10-20; amended gate round 1, Main, DECIDED item 1): Enter on a
// blank composer sends the oldest queued follow-up, exactly as that chip's own "Send now" button
// would (FR-012, issue #540). Pure derivation only -- MessageInput.tsx owns the actual Enter-key
// wiring and reuses the existing `handleSendNow`/`inFlightChips` single-flight guard (so a fast
// double Enter can never double-send); this module only decides WHETHER the rule applies this
// render and WHICH chip it targets. Kept out of MessageInput.tsx: that file is at its
// `check:file-size` baseline cap (issue #806). Not a hook (no React state/effects of its own),
// hence the plain function name rather than a `use*` one.
import type { AttachmentsState } from './attachments'
import type { DerivedChip } from './queuedChips'

/** Discriminated on `applies`: `chip` only exists (and is required) on the `true` branch, so a
 * caller can never reach for it on the `false` branch without a type error (gate round 1, Main,
 * MEDIUM item 4: replaces a plain `{ applies: boolean; chip: DerivedChip | undefined }` shape,
 * which forced the caller to assert `chip!` past a non-null the type system could not prove). */
export type EnterSendsQueuedFollowUp = { applies: true; chip: DerivedChip } | { applies: false }

/**
 * `showSlashMenu` and a live ghost-text suggestion both take priority over this rule (the
 * issue's own edge cases): Enter must never be hijacked while either is showing. Neither can
 * actually coexist with a blank draft today -- `showSlashMenu` requires `text` to start with
 * `/` (never `''`), and `isGhostTextEligible` requires text already on the line -- so both
 * guards are structurally unreachable given the blank check below and are kept only as explicit,
 * defensive belt-and-braces rather than relying on either invariant holding forever.
 *
 * "Blank" (gate round 1, Main, DECIDED item 1: amends the original "whitespace-only" wording,
 * which left a gap where the hint stayed hidden -- `text-muted-foreground` empty-state overlay
 * only ever shows for `text === ''` -- while the rule still applied for a whitespace-only
 * draft): `text` is the exact empty string, not merely blank after trimming. A single space or a
 * Shift+Enter-inserted newline is a real draft; Enter must never promote a queued follow-up over
 * it. Also requires no pending images, text chips, or file attachments, AND no attachment read
 * still in flight (`pendingAttachmentReads`, PR #723's own guard: a background path/drop image
 * read for this session must finish before the draft can be considered blank, the same race
 * `handleSend`'s own refusal already guards against). Deliberately NOT the `hasSendableContent`
 * predicate issue #744 proposes (that one treats an attachment-only draft as sendable); this is
 * the opposite question -- "is there nothing here a plain Enter could send as typed text".
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
  pendingAttachmentReads: number,
  chips: readonly DerivedChip[],
  showSlashMenu: boolean,
  ghost: { text: string } | null
): EnterSendsQueuedFollowUp {
  const isBlank =
    text === '' &&
    attachments.images.length === 0 &&
    attachments.textChips.length === 0 &&
    attachments.files.length === 0 &&
    pendingAttachmentReads === 0
  if (showSlashMenu || (ghost && ghost.text === text) || !isBlank) return { applies: false }
  const chip = chips.find((c) => c.queue === 'followUp')
  return chip ? { applies: true, chip } : { applies: false }
}
