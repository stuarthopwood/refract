// Classifies OMP's `extension_ui_request` dialogs and builds `extension_ui_response` answers,
// per specs/001-core-session-workspace/contracts/omp-usage.md ("Dialogs") and the
// `PendingRequest` shape in src/shared/model.ts. Pure: no I/O, no Electron imports.

import type { ExtensionUiRequestFrame } from '../../shared/frames';
import type { PendingRequest } from '../../shared/model';

const APPROVAL_PREFIX = 'Allow tool:';
const MAX_TARGET_LENGTH = 200;

/** Answer gathered from the renderer for a pending dialog. */
export type DialogAnswer = { approve: boolean } | { value: string } | { confirmed: boolean } | { cancelled: true };

/** Best-effort: does this detail line read as a filesystem path or a shell command? */
function looksLikePathOrCommand(line: string): boolean {
  const value = line.replace(/^[A-Za-z][A-Za-z ]*:\s*/, '');
  return /[\\/]/.test(value) || /^[\w.-]+\s+\S/.test(value);
}

function parseApprovalTitle(title: string): { tool: string; details: string[] } {
  const lines = title.split('\n');
  const tool = (lines[0] ?? '').slice(APPROVAL_PREFIX.length).trim();
  const details = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { tool, details };
}

function pickApprovalTarget(details: string[]): string {
  const candidate = details.find(looksLikePathOrCommand) ?? details[0] ?? '';
  return candidate.slice(0, MAX_TARGET_LENGTH);
}

/** Classifies a live `extension_ui_request` frame per contracts/omp-usage.md "Dialogs". */
export function classifyDialog(frame: ExtensionUiRequestFrame): PendingRequest | 'ignore' | { cancel: string } {
  switch (frame.method) {
    case 'select': {
      const title = frame.title ?? '';
      if (title.startsWith(APPROVAL_PREFIX)) {
        const { tool, details } = parseApprovalTitle(title);
        const target = pickApprovalTarget(details);
        return { kind: 'approval', requestId: frame.id, tool, target, details };
      }
      const options = frame.options ?? [];
      return frame.optionDetails
        ? { kind: 'question', requestId: frame.id, title, options, optionDetails: frame.optionDetails, allowText: false }
        : { kind: 'question', requestId: frame.id, title, options, allowText: false };
    }
    case 'input':
    case 'editor':
      return { kind: 'question', requestId: frame.id, title: frame.title ?? '', options: [], allowText: true };
    case 'confirm':
      return { kind: 'question', requestId: frame.id, title: frame.title ?? '', options: ['Yes', 'No'], allowText: false };
    case 'cancel':
      return { cancel: frame.id };
    case 'notify':
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
  if ('confirmed' in answer) {
    return { type: 'extension_ui_response', id: requestId, confirmed: answer.confirmed };
  }
  if ('value' in answer) {
    return { type: 'extension_ui_response', id: requestId, value: answer.value };
  }
  throw new Error(`unsupported dialog answer for request ${requestId}`);
}
