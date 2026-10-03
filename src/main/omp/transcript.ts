// Builds the renderer-facing TranscriptItem[] from OMP's own message history (`fromHistory`)
// and from live rpc-ui frames (`applyFrame`), per
// specs/001-core-session-workspace/contracts/omp-usage.md ("Frames Refract consumes",
// "Message parts", "Tool row fields", "Chat line wire shapes") and docs/spike/FINDINGS.md
// item 14 (edit-diff-probe) and item 22 (chat-lines-probe).
// Pure: no I/O, no Electron imports. `applyFrame` never mutates its `items` argument; it
// returns a new array, replacing only the items that changed, so callers can diff by identity.

import type {
  Frame,
  OmpCustomMessage,
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
type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>;
type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>;

const MAX_TARGET_LENGTH = 200;

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

// ---------------------------------------------------------------------------
// Subagents (T078, FINDINGS item 22(e)): a batch `task()` call's `args.tasks[]` yields one
// `subagent` item per entry, never a single `tool` item, so each has its own collapsed line.
// ---------------------------------------------------------------------------

interface TaskSpecLike {
  task?: unknown;
  name?: unknown;
}

const SUBAGENT_NAME_LENGTH = 60;

/** Reads `args.tasks[]` defensively: a malformed or absent array means the caller falls back to
 * rendering the call as a plain `tool` item instead of silently dropping it. */
function readTaskSpecs(args: unknown): TaskSpecLike[] {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return Array.isArray(record.tasks) ? (record.tasks as unknown[]).filter((t): t is TaskSpecLike => !!t && typeof t === 'object') : [];
}

function subagentName(spec: TaskSpecLike): string {
  if (typeof spec.name === 'string' && spec.name.length > 0) return spec.name;
  const task = typeof spec.task === 'string' ? spec.task : '';
  return task.length > SUBAGENT_NAME_LENGTH ? `${task.slice(0, SUBAGENT_NAME_LENGTH)}\u2026` : task;
}

/** Upserts one `subagent` item per `specs[]` entry, keyed by `subagent:<toolCallId>:<index>` so
 * the id stays stable across the toolCall message part, `tool_execution_start`, and
 * `tool_execution_end` -- none of which share a common key with each other except `toolCallId`.
 * New items are appended; existing ones are updated in place (name/task only; status/duration
 * come from `applyBatchTaskResult`/`applyAsyncResultJobs`, never from here). */
function upsertSubagentItems(items: TranscriptItem[], toolCallId: string, specs: TaskSpecLike[]): TranscriptItem[] {
  let result = items;
  specs.forEach((spec, index) => {
    const id = `subagent:${toolCallId}:${index}`;
    const name = subagentName(spec);
    const task = typeof spec.task === 'string' ? spec.task : '';
    const existingIndex = result.findIndex((item) => item.id === id);
    if (existingIndex === -1) {
      const created: TranscriptItem = { kind: 'subagent', id, toolCallId, name, task, status: 'running', startedAt: Date.now() };
      result = [...result, created];
      return;
    }
    const prior = result[existingIndex] as SubagentItem;
    const updated: SubagentItem = { ...prior, name, task };
    result = result.map((item, i) => (i === existingIndex ? updated : item));
  });
  return result;
}

interface ProgressEntry {
  id?: unknown;
  status?: unknown;
}

/** `pending` (still running) is the only status FINDINGS item 22(e) actually observed; any other
 * string is treated as a plain completion/failure signal defensively. The installed omp 18.5.1
 * binary's own job records use `'failed'`/`'cancelled'` (direct binary inspection, 2026-10-03):
 * both, plus `'error'`/`'aborted'`, must map to `error`, never fall through to `done`. */
function mapProgressStatus(status: unknown): 'running' | 'done' | 'error' {
  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'aborted') return 'error';
  if (status === 'pending') return 'running';
  return status === undefined ? 'running' : 'done';
}

interface ToolResultLike {
  toolCallId: string;
  isError?: boolean;
  details?: unknown;
}

/** Applies a `task` call's own `tool_execution_end` (live) or `toolResult` (history): per
 * FINDINGS item 22(e) this completes almost immediately with `details.progress[]` stuck at
 * `"pending"` -- not the authoritative result, just whichever per-subagent ids/statuses exist so
 * far -- so this only ever flips a subagent to `done`/`error` when `progress[i].status` already
 * says so, or (no `progress` array at all) falls back to the call's own overall status, per
 * `durationMs` only when `live` (history has no reliable wall clock to derive one from -- see
 * the `thinking` timing note below). Returns `items` unchanged (by reference) when this
 * `toolCallId` has no subagent items at all, so callers can fall through to the generic `tool`
 * item path for a malformed `task` call whose `args.tasks` never produced any. */
function applyBatchTaskResult(items: TranscriptItem[], result: ToolResultLike, live: boolean): TranscriptItem[] {
  const subagents = items.filter((item): item is SubagentItem => item.kind === 'subagent' && item.toolCallId === result.toolCallId);
  if (subagents.length === 0) return items;
  const details = result.details as { progress?: ProgressEntry[] } | undefined;
  const progress = Array.isArray(details?.progress) ? details!.progress : undefined;
  const fallbackStatus: 'done' | 'error' = result.isError ? 'error' : 'done';
  return items.map((item) => {
    if (item.kind !== 'subagent' || item.toolCallId !== result.toolCallId) return item;
    const index = subagents.indexOf(item);
    const entry = progress?.[index];
    const jobId = entry && typeof entry.id === 'string' ? entry.id : item.jobId;
    const durationField = live && item.startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - item.startedAt) } : {};
    // A hard batch failure (`result.isError`) must flip every subagent row to `error`, even one
    // whose `progress[i].status` is still `"pending"` -- otherwise that row spins forever (the
    // bug this guards against); only the `jobId` correlation from `progress` survives in that case.
    if (result.isError) {
      return { ...item, status: fallbackStatus, jobId, ...durationField };
    }
    if (entry) {
      return { ...item, status: mapProgressStatus(entry.status), jobId };
    }
    return { ...item, status: fallbackStatus, ...durationField };
  });
}

interface JobEntry {
  jobId?: unknown;
  id?: unknown;
  label?: unknown;
  durationMs?: unknown;
  status?: unknown;
  resultText?: unknown;
  schema?: { data?: unknown };
  /** The installed omp 18.5.1 binary's own failed/cancelled job records carry this (direct
   * binary inspection, 2026-10-03): the real error text, preferred over `label` whenever the job
   * did not succeed. */
  errorText?: unknown;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The authoritative per-subagent completion (FINDINGS item 22(e)/live verification, 2026-10-03):
 * a later `custom`/`async-result` message's `details.jobs[]` keys each entry by `jobId`, but the
 * `wait` tool's own `tool_execution_end` carries an equivalent `details.jobs[]` keyed by `id`
 * instead (same batch, two different carriers -- OMP reports whichever jobs a `wait` call
 * actually waited for through the tool's own result, and any that finished after that `wait`
 * returned through the separate async-result message), so both key names are matched here. Falls
 * back to matching by `label === name` for a subagent that never got a `progress` entry at all. A
 * job's plain-text result is `resultText` when present (the wait tool's shape: the subagent's
 * full raw output), `schema.data` on the async-result shape, `label` as a last resort; `status`
 * is read when present (`"pending"`/`"running"` never completes the row), else arrival itself is
 * read as `done` (the call's own `tool_execution_end` already covers a hard failure of the whole
 * batch). */
function applyAsyncResultJobs(items: TranscriptItem[], jobs: JobEntry[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind !== 'subagent') return item;
    const byJobId = jobs.find((job) => (typeof job.jobId === 'string' ? job.jobId : typeof job.id === 'string' ? job.id : undefined) === item.jobId);
    const job = byJobId ?? (item.jobId === undefined ? jobs.find((j) => typeof j.label === 'string' && j.label === item.name) : undefined);
    if (!job) return item;
    if (job.status === 'pending' || job.status === 'running') return item;
    // The installed omp 18.5.1 binary's own job records use `'failed'`/`'cancelled'` (direct
    // binary inspection, 2026-10-03): both, plus `'error'`/`'aborted'`, must flip the row to
    // `error`, never render a failed/cancelled subagent as a green-check `done`.
    const failed = job.status === 'failed' || job.status === 'error' || job.status === 'cancelled' || job.status === 'aborted';
    const resultText =
      failed && typeof job.errorText === 'string'
        ? job.errorText
        : typeof job.resultText === 'string'
          ? job.resultText
          : job.schema && typeof job.schema === 'object' && 'data' in job.schema
            ? safeStringify(job.schema.data)
            : typeof job.label === 'string'
              ? job.label
              : item.result;
    return {
      ...item,
      status: failed ? 'error' : 'done',
      durationMs: typeof job.durationMs === 'number' ? job.durationMs : item.durationMs,
      result: resultText,
      jobId: (typeof job.jobId === 'string' ? job.jobId : typeof job.id === 'string' ? job.id : undefined) ?? item.jobId,
    };
  });
}

const ASYNC_RESULT_CUSTOM_TYPE = 'async-result';

/** Returns the patched items when `message` is a batch-subagent result carrier (recognised type,
 * whether or not it had jobs to apply yet), `undefined` when it is not one at all. */
function tryApplyAsyncResult(items: TranscriptItem[], message: OmpCustomMessage): TranscriptItem[] | undefined {
  if (message.customType !== ASYNC_RESULT_CUSTOM_TYPE) return undefined;
  const details = (message as { details?: unknown }).details;
  const jobs = details && typeof details === 'object' && Array.isArray((details as { jobs?: unknown }).jobs) ? ((details as { jobs: JobEntry[] }).jobs) : undefined;
  if (!jobs) return items;
  return applyAsyncResultJobs(items, jobs);
}

// ---------------------------------------------------------------------------
// Subagent-to-parent IRC messages (T079, FR-048). FINDINGS item 22(f) could not trigger OMP's
// wire shape for this within the probe's timeout (left open for a longer-timeout re-probe), so
// this reads defensively for any `custom` message that looks like one, by a plausible
// `customType` name or by carrying `from`/`sender` fields, rather than one exact assumed shape.
// ---------------------------------------------------------------------------

const AGENT_MESSAGE_CUSTOM_TYPES = new Set(['agent-message', 'agent_message', 'irc-message', 'irc_message', 'subagent-message']);

interface AgentMessageLike {
  from?: unknown;
  to?: unknown;
  sender?: unknown;
  recipient?: unknown;
  text?: unknown;
  message?: unknown;
}

function tryBuildAgentMessage(messageId: string, message: OmpCustomMessage): TranscriptItem | undefined {
  const details = (message as { details?: unknown }).details;
  const source: AgentMessageLike | undefined = details && typeof details === 'object' ? (details as AgentMessageLike) : undefined;
  const looksLikeAgentMessage = AGENT_MESSAGE_CUSTOM_TYPES.has(message.customType) || (source !== undefined && (typeof source.from === 'string' || typeof source.sender === 'string'));
  if (!looksLikeAgentMessage) return undefined;
  const from = (typeof source?.from === 'string' ? source.from : typeof source?.sender === 'string' ? source.sender : undefined) ?? 'subagent';
  const to = (typeof source?.to === 'string' ? source.to : typeof source?.recipient === 'string' ? source.recipient : undefined) ?? 'main agent';
  const text = (typeof source?.text === 'string' ? source.text : typeof source?.message === 'string' ? source.message : undefined) ?? message.content;
  const at = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
  return { kind: 'agent-message', id: `agent-message:${messageId}`, from, to, text, at };
}

/** Best-effort fallback for T079's other hypothesis: OMP emits a subagent-to-parent IRC message
 * as its own top-level frame `type` rather than a `custom` message (FINDINGS item 22(f) could
 * not confirm either shape). Shape-detected the same way as `tryBuildAgentMessage`, not by
 * guessing a specific `type` string. Called from `SessionAgent.onFrame`'s `default` case, since
 * an unrecognised top-level frame never reaches `applyFrame` (`isKnownFrame` guards it). */
export function tryBuildAgentMessageFromUnknownFrame(frame: Frame, index: number): TranscriptItem | undefined {
  const record = frame as unknown as AgentMessageLike & { type: string };
  const looksLikeAgentMessage = AGENT_MESSAGE_CUSTOM_TYPES.has(record.type) || typeof record.from === 'string' || typeof record.sender === 'string';
  if (!looksLikeAgentMessage) return undefined;
  const from = (typeof record.from === 'string' ? record.from : typeof record.sender === 'string' ? record.sender : undefined) ?? 'subagent';
  const to = (typeof record.to === 'string' ? record.to : typeof record.recipient === 'string' ? record.recipient : undefined) ?? 'main agent';
  const text = typeof record.text === 'string' ? record.text : typeof record.message === 'string' ? record.message : undefined;
  if (!text) return undefined;
  return { kind: 'agent-message', id: `agent-message:frame-${index}`, from, to, text, at: Date.now() };
}

/** Builds/merges the items for one assistant message's `content[]` snapshot. `captureTiming` is
 * false for `fromHistory`: a historical message carries only one `timestamp` for its whole
 * `content[]`, not a per-`thinking`-part (or `tool`/`subagent`) start/end, so stamping one from
 * `Date.now()` at load time would show a meaningless "Thought for 0s"/wrong multi-hour duration
 * on every reopened Conversation instead of the required plain "Thought" (T075, FR-009) --
 * `startedAt` is simply omitted in that case, same as `thinking`'s own `startedAt?`. A `task`
 * toolCall's subagents are built in place here, at the toolCall's own position (never appended
 * to the whole transcript's end), and merged against `existingItems` (the WHOLE transcript, not
 * just this message's own items) by each subagent's own stable id -- a subagent row is keyed by
 * `toolCallId`, not by the message that started it, so a messageId-prefix lookup would never
 * find it. */
function buildAssistantItems(
  messageId: string,
  parts: OmpMessageContentPart[],
  streaming: boolean,
  existingItems: TranscriptItem[],
  captureTiming: boolean,
): TranscriptItem[] {
  const existingForMessage = existingItems.filter((item) => item.id === messageId || item.id.startsWith(`${messageId}:`));
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
      if (!captureTiming) {
        result.push({ kind: 'thinking', id, text: part.thinking, streaming });
        return;
      }
      const existing = existingForMessage.find((item): item is ThinkingItem => item.kind === 'thinking' && item.id === id);
      const startedAt = existing?.startedAt ?? Date.now();
      const endedAt = !streaming ? (existing?.endedAt ?? Date.now()) : existing?.endedAt;
      result.push({ kind: 'thinking', id, text: part.thinking, streaming, startedAt, ...(endedAt !== undefined ? { endedAt } : {}) });
      return;
    }
    if (part.type === 'toolCall') {
      if (part.name === 'task') {
        const specs = readTaskSpecs(part.arguments);
        if (specs.length > 0) {
          specs.forEach((spec, specIndex) => {
            const subId = `subagent:${part.id}:${specIndex}`;
            const name = subagentName(spec);
            const task = typeof spec.task === 'string' ? spec.task : '';
            const existing = existingItems.find((item): item is SubagentItem => item.kind === 'subagent' && item.id === subId);
            if (existing) {
              result.push({ ...existing, name, task });
            } else {
              result.push({
                kind: 'subagent',
                id: subId,
                toolCallId: part.id,
                name,
                task,
                status: 'running',
                ...(captureTiming ? { startedAt: Date.now() } : {}),
              });
            }
          });
          return;
        }
      }
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
          ...(captureTiming ? { startedAt: Date.now() } : {}),
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
 * preserving its position; appends at the end for a brand-new message. Also strips any item
 * whose id appears in `replacement` from wherever it currently sits (a `subagent` item is keyed
 * by `toolCallId`, not `messageId`, so it never matches the `messageId` prefix, but `replacement`
 * now builds it in place -- without this it would be duplicated rather than moved). The
 * `agent-message` item built below is keyed by `messageId` directly, so it IS covered by the
 * plain prefix match -- a `replaceMessageItems` call with a one-item replacement works for it
 * unchanged). */
function replaceMessageItems(items: TranscriptItem[], messageId: string, replacement: TranscriptItem[]): TranscriptItem[] {
  const replacementIds = new Set(replacement.map((item) => item.id));
  const matches = (item: TranscriptItem) => item.id === messageId || item.id.startsWith(`${messageId}:`) || replacementIds.has(item.id);
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
      const built = buildAssistantItems(messageId, message.content, streaming, items, true);
      return replaceMessageItems(items, messageId, built);
    }
    case 'user': {
      const text = joinText(message.content);
      const at = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
      return replaceMessageItems(items, messageId, [{ kind: 'user', id: messageId, text, at }]);
    }
    case 'custom': {
      const asyncResult = tryApplyAsyncResult(items, message);
      if (asyncResult) return asyncResult;
      const agentMessage = tryBuildAgentMessage(messageId, message);
      if (agentMessage) return replaceMessageItems(items, messageId, [agentMessage]);
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
  if (frame.toolName === 'task') {
    const specs = readTaskSpecs(frame.args);
    if (specs.length > 0) return upsertSubagentItems(items, frame.toolCallId, specs);
  }
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

function jobsFromDetails(details: unknown): JobEntry[] | undefined {
  return details && typeof details === 'object' && Array.isArray((details as { jobs?: unknown }).jobs)
    ? (details as { jobs: JobEntry[] }).jobs
    : undefined;
}

function applyToolExecutionEnd(items: TranscriptItem[], frame: ToolExecutionEndFrame): TranscriptItem[] {
  if (frame.toolName === 'task') {
    const updated = applyBatchTaskResult(items, { toolCallId: frame.toolCallId, isError: frame.isError, details: frame.result.details }, true);
    if (updated !== items) return updated;
  }
  // The `wait` tool's own `tool_execution_end` is the other real carrier of per-subagent
  // completion (see `applyAsyncResultJobs`'s doc comment): apply its `details.jobs[]` the same
  // way regardless of tool name, so a batch a `wait` call actually waited for completes its rows
  // instead of leaving them `running` forever once the separate async-result message never
  // arrives for jobs a `wait` call already resolved.
  const waitJobs = jobsFromDetails(frame.result.details);
  if (waitJobs) items = applyAsyncResultJobs(items, waitJobs);
  const existing = items.find((item): item is ToolItem => isToolItem(item) && item.toolCallId === frame.toolCallId);
  const isError = frame.isError;
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
      details: frame.result.details,
      ...(edit ? { edit } : {}),
    };
    return [...items, created];
  }
  const updated: TranscriptItem = {
    ...existing,
    status: isError ? 'error' : 'done',
    durationMs: existing.startedAt !== undefined ? Math.max(0, Date.now() - existing.startedAt) : 0,
    output,
    details: frame.result.details,
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
 * in contracts/omp-usage.md "Frames Refract consumes" without throwing. */
export function applyFrame(items: TranscriptItem[], frame: Frame): TranscriptItem[] {
  if (!isKnownFrame(frame)) return items;
  switch (frame.type) {
    case 'message_start':
      return applyMessageSnapshot(items, frame.messageId, frame.message, true);
    case 'message_update': {
      const partial = frame.assistantMessageEvent.partial;
      if (!partial) return items;
      return applyMessageSnapshot(items, frame.messageId, partial, true);
    }
    case 'message_end':
      return applyMessageSnapshot(items, frame.messageId, frame.message, false);
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
  if (message.toolName === 'task') {
    const updated = applyBatchTaskResult(items, { toolCallId: message.toolCallId, isError: message.isError, details: message.details }, false);
    if (updated !== items) return updated;
  }
  const historyWaitJobs = jobsFromDetails(message.details);
  if (historyWaitJobs) items = applyAsyncResultJobs(items, historyWaitJobs);
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
      args: undefined,
      output,
      details: message.details,
      ...(edit ? { edit } : {}),
    };
    return [...items, created];
  }
  const updated: TranscriptItem = {
    ...existing,
    status: message.isError ? 'error' : 'done',
    output,
    details: message.details,
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
        items = [...items, ...buildAssistantItems(messageId, message.content, false, items, false)];
        return;
      }
      case 'user': {
        const text = joinText(message.content);
        const at = typeof message.timestamp === 'number' ? message.timestamp : 0;
        items = [...items, { kind: 'user', id: messageId, text, at }];
        return;
      }
      case 'custom': {
        const asyncResult = tryApplyAsyncResult(items, message);
        if (asyncResult) {
          items = asyncResult;
          return;
        }
        const agentMessage = tryBuildAgentMessage(messageId, message);
        if (agentMessage) {
          items = [...items, agentMessage];
          return;
        }
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
