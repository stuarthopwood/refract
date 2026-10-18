/** Issue #457: two independent view filters for the chat transcript, applied in the renderer
 * (never main's `HIDDEN_TOOLS` path -- that path removes a tool call from the transcript
 * entirely, before it ever reaches the renderer, which would also hide the always-visible
 * exceptions this issue requires: approvals, answered/pending `ask` questions, and failed tool
 * calls). Hiding is a view filter only: hidden items stay in the persisted Conversation, so
 * turning a toggle back on restores them with no reload. The renderer consumer is
 * `Transcript.tsx`'s `rowVisibility`. Split out of `model.ts` (not inline there) to keep that
 * file within this build's 600-line cap (issue #806), the same reason `ThemeId` lives in its own
 * `themes.ts` rather than `model.ts`; re-exported from `model.ts` so every existing import from
 * `../../shared/model` keeps working unchanged. */
export interface TranscriptDisplaySettings {
  thinking: boolean;
  toolCalls: boolean;
}

/** Defaults (issue #457): both on, so nothing changes until the user opts out. */
// Quality-gate fix (security-auditor, Low): frozen so this shared default object can never be
// mutated in place by a future call site (every current reader already spreads it, never writes
// through it, but a frozen object makes that the only option instead of an unenforced convention).
export const DEFAULT_TRANSCRIPT_DISPLAY: Readonly<TranscriptDisplaySettings> = Object.freeze({ thinking: true, toolCalls: true });
