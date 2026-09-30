// Builds the renderer-facing TranscriptItem[] from OMP's own message history (`fromHistory`)
// and from live rpc-ui frames (`applyFrame`), per
// specs/001-core-session-workspace/contracts/omp-usage.md ("Frames Pinion consumes",
// "Message parts", "Tool row fields") and docs/spike/FINDINGS.md item 14 (edit-diff-probe).
// Pure: no I/O, no Electron imports. `applyFrame` never mutates its `items` argument; it
// returns a new array, replacing only the items that changed, so callers can diff by identity.

import type {
  Frame,
  OmpMessage,
  OmpMessageContentPart,
  OmpTextPart,
  OmpToolResultMessage,
  PromptResultFrame,
  ToolExecutionEndFrame,
  ToolExecutionStartFrame,
} from '../../shared/frames';
import { isKnownFrame } from '../../shared/frames';
import type { TranscriptItem } from '../../shared/model';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const MAX_TARGET_LENGTH = 200;

// `message_start` / `message_update` / `message_end` all carry a top-level `messageId` string
// identifying the message across its lifecycle (contracts/omp-usage.md), but the frames.ts
// interfaces for those three frame types don't declare it (verified against a real capture,
// docs/spike/resume-probe.mjs frames/P0-seed.jsonl: `{"type":"message_start",...,"messageId":"msg-4"}`).
// Named const (not an inline cast) because the real wire shape disagrees with the declared type.
function readMessageId(frame: unknown): string {
  const wire = frame as { messageId?: unknown };
  return typeof wire.messageId === 'string' ? wire.messageId : '';
}

// `ToolExecutionEndFrame.result.isError` is declared nested under `result`, but a real capture
// (docs/spike/pinion-edit-diff-probe frames/edit-diff.jsonl) shows `isError` on the frame itself,
// sibling to `result`. Named const (not an inline cast) because the real wire shape disagrees
// with the declared type.
function readToolIsError(frame: ToolExecutionEndFrame): boolean {
  const wire = frame as unknown as ToolExecutionEndFrame & { isError?: boolean };
  return wire.isError ?? frame.result.isError ?? false;
}

function firstStringArg(args: unknown): string {
  if (args && typeof args === 'object') {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

/** The hashline patch's first `[<path>#<TAG>]` header line; `<path>` is the edit target, never the
 * patch body (a `write`/`read`/`bash`/`grep` argument, by contrast, is already a plain string). */
const EDIT_HEADER_PATH_RE = /\[(.+?)#[0-9A-Fa-f]{4}\]/;

function extractEditTarget(input: unknown): string {
  if (typeof input !== 'string') return '';
  const match = EDIT_HEADER_PATH_RE.exec(input);
  return match ? match[1]! : '';
}

/** Tool row fields: target = the tool's primary argument. */
function extractTarget(tool: string, args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  let raw: string;
  if (tool === 'edit') {
    // `edit`'s `args` is `{ input: '[<path>#<tag>]\nPUT ...' }` (a hashline patch): the target is
    // the path in the first header line, not the patch body.
    raw = extractEditTarget(record.input) || firstStringArg(args);
  } else if (tool === 'read' || tool === 'write') {
    raw = typeof record.path === 'string' ? record.path : firstStringArg(args);
  } else if (tool === 'bash') {
    raw = typeof record.command === 'string' ? record.command : firstStringArg(args);
  } else if (tool === 'grep' || tool === 'glob') {
    raw = typeof record.pattern === 'string' ? record.pattern : firstStringArg(args);
  } else {
    raw = firstStringArg(args);
  }
  return raw.slice(0, MAX_TARGET_LENGTH);
}

function buildWriteField(tool: string, args: unknown): ToolItem['write'] {
  if (tool !== 'write' || !args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const { path, content } = record;
  if (typeof path === 'string' && typeof content === 'string') {
    return { path, content };
  }
  return undefined;
}

function buildEditField(tool: string, details: unknown): ToolItem['edit'] {
  if (tool !== 'edit' || !details || typeof details !== 'object') return undefined;
  const record = details as Record<string, unknown>;
  const { path, oldText, newText } = record;
  if (typeof path === 'string' && typeof oldText === 'string' && typeof newText === 'string') {
    return { path, oldText, newText };
  }
  return undefined;
}

function joinText(parts: OmpMessageContentPart[]): string {
  return parts
    .filter((part): part is OmpTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isToolItem(item: TranscriptItem): item is ToolItem {
  return item.kind === 'tool';
}

/** Builds/merges the items for one assistant message's `content[]` snapshot. */
function buildAssistantItems(
  messageId: string,
  parts: OmpMessageContentPart[],
  streaming: boolean,
  existingForMessage: TranscriptItem[],
): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  parts.forEach((part, index) => {
    const id = `${messageId}:${index}`;
    if (part.type === 'text') {
      result.push({ kind: 'assistant-text', id, text: part.text, streaming });
      return;
    }
    if (part.type === 'thinking') {
      // Kept only when the text is non-empty (contracts/omp-usage.md "Message parts").
      if (part.thinking.length === 0) return;
      result.push({ kind: 'thinking', id, text: part.thinking, streaming });
      return;
    }
    if (part.type === 'toolCall') {
      const existing = existingForMessage.find((item): item is ToolItem => isToolItem(item) && item.id === id);
      const target = extractTarget(part.name, part.arguments);
      const write = buildWriteField(part.name, part.arguments);
      if (existing) {
        result.push({ ...existing, tool: part.name, target, args: part.arguments, ...(write ? { write } : {}) });
      } else {
        result.push({
          kind: 'tool',
          id,
          toolCallId: part.id,
          tool: part.name,
          target,
          status: 'running',
          startedAt: Date.now(),
          args: part.arguments,
          ...(write ? { write } : {}),
        });
      }
      return;
    }
    // Unknown content part type: ignore without throwing.
  });
  return result;
}

/** Replaces every item belonging to `messageId` (single id or `id:index`) with `replacement`,
 * preserving its position; appends at the end for a brand-new message. */
function replaceMessageItems(items: TranscriptItem[], messageId: string, replacement: TranscriptItem[]): TranscriptItem[] {
  const matches = (item: TranscriptItem) => item.id === messageId || item.id.startsWith(`${messageId}:`);
  if (!items.some(matches)) {
    return replacement.length === 0 ? items : [...items, ...replacement];
  }
  const withoutMessage = items.filter((item) => !matches(item));
  let insertAt = 0;
  for (const item of items) {
    if (matches(item)) break;
    insertAt += 1;
  }
  return [...withoutMessage.slice(0, insertAt), ...replacement, ...withoutMessage.slice(insertAt)];
}

function applyMessageSnapshot(
  items: TranscriptItem[],
  messageId: string,
  message: OmpMessage,
  streaming: boolean,
): TranscriptItem[] {
  if (!messageId) return items;
  switch (message.role) {
    case 'assistant': {
      const existingForMessage = items.filter((item) => item.id === messageId || item.id.startsWith(`${messageId}:`));
      const built = buildAssistantItems(messageId, message.content, streaming, existingForMessage);
      return replaceMessageItems(items, messageId, built);
    }
    case 'user': {
      const text = joinText(message.content);
      const at = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
      return replaceMessageItems(items, messageId, [{ kind: 'user', id: messageId, text, at }]);
    }
    case 'custom': {
      if (message.display === true) {
        return replaceMessageItems(items, messageId, [{ kind: 'notice', id: messageId, level: 'info', text: message.content }]);
      }
      return replaceMessageItems(items, messageId, []);
    }
    // `developer` is always hidden; `toolResult` live output comes from tool_execution_end, not
    // from the message lifecycle frames (contracts/omp-usage.md "Message parts").
    case 'developer':
    case 'toolResult':
    default:
      return items;
  }
}

function applyToolExecutionStart(items: TranscriptItem[], frame: ToolExecutionStartFrame): TranscriptItem[] {
  const existing = items.find((item): item is ToolItem => isToolItem(item) && item.toolCallId === frame.toolCallId);
  const target = extractTarget(frame.toolName, frame.args);
  const write = buildWriteField(frame.toolName, frame.args);
  if (!existing) {
    const created: TranscriptItem = {
      kind: 'tool',
      id: `tool-exec:${frame.toolCallId}`,
      toolCallId: frame.toolCallId,
      tool: frame.toolName,
      target,
      status: 'running',
      startedAt: Date.now(),
      args: frame.args,
      ...(write ? { write } : {}),
    };
    return [...items, created];
  }
  const updated: TranscriptItem = {
    ...existing,
    tool: frame.toolName,
    target,
    args: frame.args,
    status: 'running',
    startedAt: Date.now(),
    ...(write ? { write } : {}),
  };
  return items.map((item) => (item === existing ? updated : item));
}

function applyToolExecutionEnd(items: TranscriptItem[], frame: ToolExecutionEndFrame): TranscriptItem[] {
  const existing = items.find((item): item is ToolItem => isToolItem(item) && item.toolCallId === frame.toolCallId);
  const isError = readToolIsError(frame);
  const output = joinText(frame.result.content);
  const edit = buildEditField(frame.toolName, frame.result.details);
  if (!existing) {
    const created: TranscriptItem = {
      kind: 'tool',
      id: `tool-exec:${frame.toolCallId}`,
      toolCallId: frame.toolCallId,
      tool: frame.toolName,
      target: '',
      status: isError ? 'error' : 'done',
      startedAt: Date.now(),
      durationMs: 0,
      args: undefined,
      output,
      ...(edit ? { edit } : {}),
    };
    return [...items, created];
  }
  const updated: TranscriptItem = {
    ...existing,
    status: isError ? 'error' : 'done',
    durationMs: Math.max(0, Date.now() - existing.startedAt),
    output,
    ...(edit ? { edit } : {}),
  };
  return items.map((item) => (item === existing ? updated : item));
}

function applyPromptResultNotice(items: TranscriptItem[], frame: PromptResultFrame): TranscriptItem[] {
  if (frame.status === 'error') {
    const text = frame.error ?? 'Prompt failed.';
    return [...items, { kind: 'notice', id: `notice-${items.length}`, level: 'error', text }];
  }
  if (frame.status === 'aborted') {
    return [...items, { kind: 'notice', id: `notice-${items.length}`, level: 'info', text: 'Turn aborted.' }];
  }
  return items;
}

/** Applies one live rpc-ui frame to the current transcript. Ignores every frame type not listed
 * in contracts/omp-usage.md "Frames Pinion consumes" without throwing. */
export function applyFrame(items: TranscriptItem[], frame: Frame): TranscriptItem[] {
  if (!isKnownFrame(frame)) return items;
  switch (frame.type) {
    case 'message_start':
      return applyMessageSnapshot(items, readMessageId(frame), frame.message, true);
    case 'message_update': {
      const partial = frame.assistantMessageEvent.partial;
      if (!partial) return items;
      return applyMessageSnapshot(items, readMessageId(frame), partial, true);
    }
    case 'message_end':
      return applyMessageSnapshot(items, readMessageId(frame), frame.message, false);
    case 'tool_execution_start':
      return applyToolExecutionStart(items, frame);
    case 'tool_execution_end':
      return applyToolExecutionEnd(items, frame);
    case 'prompt_result':
      return applyPromptResultNotice(items, frame);
    case 'command_output': {
      const text = typeof frame.text === 'string' ? frame.text : typeof frame.message === 'string' ? frame.message : '';
      if (!text) return items;
      return [...items, { kind: 'notice', id: `notice-${items.length}`, level: 'info', text }];
    }
    case 'notice':
      return [...items, { kind: 'notice', id: `notice-${items.length}`, level: frame.level, text: frame.message }];
    default:
      return items;
  }
}

function attachToolResult(items: TranscriptItem[], message: OmpToolResultMessage): TranscriptItem[] {
  const existing = items.find((item): item is ToolItem => isToolItem(item) && item.toolCallId === message.toolCallId);
  const output = joinText(message.content);
  const edit = buildEditField(message.toolName, message.details);
  if (!existing) {
    const created: TranscriptItem = {
      kind: 'tool',
      id: `tool-hist:${message.toolCallId}`,
      toolCallId: message.toolCallId,
      tool: message.toolName,
      target: '',
      status: message.isError ? 'error' : 'done',
      startedAt: 0,
      args: undefined,
      output,
      ...(edit ? { edit } : {}),
    };
    return [...items, created];
  }
  const updated: TranscriptItem = {
    ...existing,
    status: message.isError ? 'error' : 'done',
    output,
    ...(edit ? { edit } : {}),
  };
  return items.map((item) => (item === existing ? updated : item));
}

/** Builds the transcript for a stored session's history (from `get_messages`), per
 * contracts/omp-usage.md "Message parts". */
export function fromHistory(messages: OmpMessage[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  messages.forEach((message, index) => {
    const messageId = `h${index}`;
    switch (message.role) {
      case 'assistant': {
        items = [...items, ...buildAssistantItems(messageId, message.content, false, [])];
        return;
      }
      case 'user': {
        const text = joinText(message.content);
        const at = typeof message.timestamp === 'number' ? message.timestamp : 0;
        items = [...items, { kind: 'user', id: messageId, text, at }];
        return;
      }
      case 'custom': {
        if (message.display === true) {
          items = [...items, { kind: 'notice', id: messageId, level: 'info', text: message.content }];
        }
        return;
      }
      case 'toolResult': {
        items = attachToolResult(items, message);
        return;
      }
      case 'developer':
      default:
        return;
    }
  });
  return items;
}
