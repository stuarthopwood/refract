// Classifies OMP's `extension_ui_request` dialogs and builds `extension_ui_response` answers,
// per specs/001-core-session-workspace/contracts/omp-usage.md ("Dialogs") and the
// `PendingRequest` shape in src/shared/model.ts. Pure: no I/O, no Electron imports.

import type { ExtensionUiRequestFrame } from '../../shared/frames';
import type { PendingRequest } from '../../shared/model';

const APPROVAL_PREFIX = 'Allow tool:';
const MAX_TARGET_LENGTH = 200;

/** Answer gathered from the renderer for a pending dialog. */
export type DialogAnswer = { approve: boolean } | { value: string } | { confirmed: boolean } | { cancelled: true };

/** Matches a `Path:`/`File:`/`Command:` label at the START of a single line (not scanned across
 * lines: security fix -- a later detail line must never spoof the headline target, e.g. a bash
 * command whose own text happens to contain a line reading `Path: README.md`). */
const LABEL_RE = /^(?:Path|File|Command):\s*/i;

function parseApprovalTitle(title: string): { tool: string; details: string[] } {
  const lines = title.split('\n');
  const tool = (lines[0] ?? '').slice(APPROVAL_PREFIX.length).trim();
  const details = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { tool, details };
}

/** The approval's headline target: a `Path:`/`File:`/`Command:` label, but ONLY when it starts
 * the first non-empty detail line; any other first line (or no details at all) falls back to the
 * tool name alone. `details` is unchanged and kept in full for the expanded view. */
function pickApprovalTarget(tool: string, details: string[]): string {
  const first = details[0];
  if (typeof first === 'string') {
    const match = LABEL_RE.exec(first);
    if (match) return first.slice(match[0].length).slice(0, MAX_TARGET_LENGTH);
  }
  return tool.slice(0, MAX_TARGET_LENGTH);
}

/** Classifies a live `extension_ui_request` frame per contracts/omp-usage.md "Dialogs". */
export function classifyDialog(
  frame: ExtensionUiRequestFrame,
): PendingRequest | 'ignore' | { cancel: string } | { notify: { message: string; level: 'info' | 'warning' | 'error' } } {
  switch (frame.method) {
    case 'select': {
      const title = frame.title ?? '';
      if (title.startsWith(APPROVAL_PREFIX)) {
        const { tool, details } = parseApprovalTitle(title);
        const target = pickApprovalTarget(tool, details);
        return { kind: 'approval', requestId: frame.id, tool, target, details };
      }
      const options = frame.options ?? [];
      const optionDetails = frame.optionDetails?.map((detail) => detail.description);
      return optionDetails
        ? { kind: 'question', requestId: frame.id, title, options, optionDetails, inputKind: 'choice' }
        : { kind: 'question', requestId: frame.id, title, options, inputKind: 'choice' };
    }
    case 'input':
    case 'editor':
      return { kind: 'question', requestId: frame.id, title: frame.title ?? '', options: [], inputKind: 'text' };
    case 'confirm':
      return {
        kind: 'question',
        requestId: frame.id,
        title: frame.title ?? '',
        message: frame.message,
        options: ['Yes', 'No'],
        inputKind: 'confirm',
      };
    case 'cancel':
      // `targetId` names the dialog being withdrawn; the cancel frame's own `id` is unrelated
      // (rpc-types.ts: `{ id, method: "cancel", targetId }`). Fall back to `id` only as a last
      // resort so a malformed frame never throws; it then simply matches no pending request.
      return { cancel: frame.targetId ?? frame.id };
    case 'notify':
      return { notify: { message: frame.message ?? '', level: frame.notifyType ?? 'info' } };
    case 'setStatus':
    case 'setWidget':
    case 'setTitle':
    case 'set_editor_text':
    case 'open_url':
      return 'ignore';
    default:
      return 'ignore';
  }
}

/** Builds the `extension_ui_response` object for a resolved dialog answer. */
export function buildDialogResponse(requestId: string, request: PendingRequest, answer: DialogAnswer): object {
  if ('cancelled' in answer) {
    return { type: 'extension_ui_response', id: requestId, cancelled: true };
  }
  if (request.kind === 'approval') {
    if (!('approve' in answer)) {
      throw new Error(`expected an approve answer for approval request ${requestId}`);
    }
    return { type: 'extension_ui_response', id: requestId, value: answer.approve ? 'Approve' : 'Deny' };
  }
  // Defensive: OMP's `confirm` reads only `confirmed` (rpc-mode.ts), never `value`; accept a
  // `{ value: 'Yes' | 'No' }` answer for a confirm question and translate it, in case any caller
  // ever sends the generic select-style shape for a confirm request.
  if (request.inputKind === 'confirm' && 'value' in answer) {
    return { type: 'extension_ui_response', id: requestId, confirmed: answer.value === 'Yes' };
  }
  if ('confirmed' in answer) {
    return { type: 'extension_ui_response', id: requestId, confirmed: answer.confirmed };
  }
  if ('value' in answer) {
    return { type: 'extension_ui_response', id: requestId, value: answer.value };
  }
  throw new Error(`unsupported dialog answer for request ${requestId}`);
}
