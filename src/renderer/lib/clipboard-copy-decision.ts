// Pure, dependency-free helpers for CopyButton's click-handler decisions (quality-gate
// remediation, cycle 4): extracted so the two branches vitest's `node` environment could not
// otherwise reach through `copy-button.tsx` (which pulls in React/Radix/the renderer state
// barrel) are directly unit-testable.
import type { IpcError } from '../../shared/ipc'

export type CopyDecision = { kind: 'copy'; text: string } | { kind: 'nothing' }

/** Decides what a click does once the text is already sanitised: `''` means there was nothing
 * left to copy (an agent-authored block made entirely of stripped characters), everything else
 * is copied as-is. */
export function copyDecision(sanitisedText: string): CopyDecision {
  return sanitisedText === '' ? { kind: 'nothing' } : { kind: 'copy', text: sanitisedText }
}

/** Builds the same `{ok: false, error: {code: 'clipboard-failed', ...}}` shape the main-process
 * clipboard handler itself returns (`src/main/ipc/clipboard.ts`), for when the IPC *call itself*
 * rejects (e.g. the channel is gone, or main throws synchronously) rather than resolving with an
 * `{ok: false}` result -- the renderer's own fallback path has no other way to report that. */
export function clipboardRejectionToResult(err: unknown): { ok: false; error: IpcError } {
  return { ok: false, error: { code: 'clipboard-failed', message: err instanceof Error ? err.message : String(err) } }
}
