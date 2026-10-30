export interface OmpTextPart {
  type: 'text';
  text: string;
}

export interface OmpThinkingPart {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
}

export interface OmpToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
  intent?: string;
}

export type OmpMessageContentPart = OmpTextPart | OmpThinkingPart | OmpToolCallPart;

export interface OmpUserMessage {
  role: 'user';
  content: OmpMessageContentPart[];
  attribution?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface OmpAssistantMessage {
  role: 'assistant';
  content: OmpMessageContentPart[];
  timestamp?: number;
  // Provider bookkeeping (model, usage, stopReason, providerPayload, ...) Refract does not read.
  [key: string]: unknown;
}

export interface OmpToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: OmpTextPart[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

export interface OmpCustomMessage {
  role: 'custom';
  customType: string;
  content: string;
  display?: boolean;
  attribution?: string;
  timestamp?: number;
  details?: unknown;
  [key: string]: unknown;
}

export interface OmpDeveloperMessage {
  role: 'developer';
  content: OmpMessageContentPart[];
  attribution?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export type OmpMessage =
  | OmpUserMessage
  | OmpAssistantMessage
  | OmpToolResultMessage
  | OmpCustomMessage
  | OmpDeveloperMessage;

export interface SlashCommandDescriptor {
  name: string;
  description: string;
  aliases?: string[];
  input?: { hint: string };
  subcommands?: SlashCommandDescriptor[];
  source?: 'builtin' | 'file' | 'skill' | 'native' | (string & {}); // #760: OMP's own field ('builtin'/'file'/'skill'), or 'native' for a locally-supplied descriptor (`/new`/`/btw`); absent = 'builtin' (fail-closed default, `session::agent::commands.rs`). `(string & {})` keeps unknown future values accepted without widening to a bare `string`.
}

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor' | 'ask' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | 'open_url' | 'cancel';

export interface ExtensionUiRequestFrame {
  type: 'extension_ui_request';
  id: string;
  method: ExtensionUiMethod;
  title?: string;
  options?: string[];
  optionDetails?: { description?: string }[];
  message?: string;
  notifyType?: 'info' | 'warning' | 'error';
  questions?: Array<{ id: string; question: string; header?: string; options: Array<{ label: string; description?: string; preview?: string }>; multi?: boolean; recommended?: number }>;
  /** `method:'ask'` only, in milliseconds (OMP's own `setTimeout` value, not seconds), when `ask.timeout` is configured non-zero. */
  timeout?: number;
  /** Present only on `method: 'cancel'`: the `id` of the dialog being withdrawn. */
  targetId?: string;
  // SetWidget/setStatus/setTitle/set_editor_text/open_url carry method-specific fields this
  // contract does not enumerate.
  [key: string]: unknown;
}

/** `{ answers }` answers an `ask` request. */
export type ExtensionUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> };

export interface ExtensionUiResponseCommand {
  type: 'extension_ui_response';
  id: string;
}

export interface GetStateResponseData {
  sessionFile: string;
  sessionId: string;
  messageCount: number;
  isSettled: boolean;
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  /** Confirmed present both before and after a turn runs. */
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
  [key: string]: unknown;
}

export interface GetMessagesResponseData {
  messages: OmpMessage[];
}

/** `nextCursor` is an opaque, server-issued continuation token. */
export interface GetMessagesPageResponseData {
  messages: OmpMessage[];
  nextCursor?: string;
  totalMessages: number;
}

export interface SwitchSessionResponseData {
  cancelled: boolean;
}

export interface GetAvailableCommandsResponseData {
  commands: SlashCommandDescriptor[];
}

export interface PredictWordResponseData {
  suffix: string | null;
}

/** `record` is typed `BtwHistoryThread` to match. */
export interface BtwResponseData {
  record: BtwHistoryThread;
}

/** `get_btw_history`'s response. */
export interface GetBtwHistoryResponseData {
  records: BtwHistoryThread[];
}

export interface ReadyFrame {
  type: 'ready';
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes?: number;
}

export interface ResponseFrame<T = unknown> {
  type: 'response';
  id: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface AgentStartFrame {
  type: 'agent_start';
}

export interface AgentEndFrame {
  type: 'agent_end';
  messages: OmpMessage[];
}

export interface MessageStartFrame {
  type: 'message_start';
  messageId: string;
  message: OmpMessage;
}

export interface MessageUpdateFrame {
  type: 'message_update';
  messageId: string;
  assistantMessageEvent: {
    type: string;
    contentIndex?: number;
    partial?: OmpMessage;
    [key: string]: unknown;
  };
}

export interface MessageEndFrame {
  type: 'message_end';
  messageId: string;
  message: OmpMessage;
}

export interface ToolExecutionStartFrame {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionEndFrame {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: {
    content: OmpTextPart[];
    details?: unknown;
  };
  /** Sibling of `result`, not nested under it (verified against a real capture). */
  isError: boolean;
}

/** Each `progress[]` entry is keyed by `id`, which is stable and equals that subagent's own `name`. */
export interface ToolExecutionUpdateFrame {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: {
    content: OmpTextPart[];
    details: {
      progress: Array<{
        index: number;
        id: string;
        status: string;
        task?: string;
        assignment?: string;
        recentTools?: Array<{ tool: string; args?: unknown; argsKey?: string; intent?: string; isError: boolean; endMs: number }>;
        recentOutput?: unknown[];
        durationMs?: number;
        extractedToolData?: Record<string, Array<{ data: unknown; status: string }>>;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  };
}

export interface QueueUpdateFrame {
  type: 'queue_update';
  followUp: string[];
  steering: string[];
}

export interface PromptResultError {
  message: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable?: boolean;
}

export interface PromptResultFrame {
  type: 'prompt_result';
  id: string;
  agentInvoked: boolean;
  status: 'completed' | 'aborted' | 'error';
  sessionSettled?: boolean;
  /** Per `rpc.md`: a structured object, not a string, when `status === 'error'`. */
  error?: string | PromptResultError;
}

export interface SessionSettledFrame {
  type: 'session_settled';
}

export interface AvailableCommandsUpdateFrame {
  type: 'available_commands_update';
  commands: SlashCommandDescriptor[];
}

/** Local slash-command output (agentInvoked: false); can arrive before or after the prompt's own response. */
export interface CommandOutputFrame {
  type: 'command_output';
  text?: string;
  message?: string;
  [key: string]: unknown;
}

/** Absent on an ordinary notice. */
export interface NoticeFrame {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
}

/** V1 frames are capped at maxFrameBytes. */
export interface RpcChunkFrame {
  type: 'rpc_chunk';
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/** Confirmed live (2026-10-11). */
export interface BtwHistoryNode {
  question: string;
  answer: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  error?: string;
  followUps?: BtwHistoryNode[];
}

/** One `get_btw_history` array entry. */
export interface BtwHistoryThread extends BtwHistoryNode {
  id: string;
  leafId: string;
}

export interface SideChatRecord {
  id: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  question: string;
  answer?: string;
  createdAt?: number;
  updatedAt?: number;
  /** The value the NEXT question in this topic must carry as `recordId`. */
  topicId?: string;
  /** Present only when this record is a history thread's own root. Use `topicId` (or this record's own `id` when it IS the root) to continue a topic, never this field. */
  leafId?: string;
  error?: string;
}

export interface BtwDeltaFrame {
  type: 'btw_delta';
  recordId: string;
  /** `recordId` here is always the TOPIC's own root id (see `SideChatRecord.topicId`'s doc comment), never the latest turn's own flattened id. */
  delta: string;
}

export interface BtwRecordFrame {
  type: 'btw_record';
  record: BtwHistoryThread;
}

export type KnownFrame =
  | ReadyFrame
  | ResponseFrame
  | AgentStartFrame
  | AgentEndFrame
  | MessageStartFrame
  | MessageUpdateFrame
  | MessageEndFrame
  | ToolExecutionStartFrame
  | ToolExecutionEndFrame
  | ToolExecutionUpdateFrame
  | QueueUpdateFrame
  | ExtensionUiRequestFrame
  | PromptResultFrame
  | SessionSettledFrame
  | AvailableCommandsUpdateFrame
  | CommandOutputFrame
  | NoticeFrame
  | RpcChunkFrame
  | BtwDeltaFrame
  | BtwRecordFrame;

/** Anything OMP sends whose `type` Refract does not recognise. */
export interface UnknownFrame {
  type: string;
  [key: string]: unknown;
}

export type Frame = KnownFrame | UnknownFrame;

const KNOWN_FRAME_TYPES: Record<KnownFrame['type'], true> = {
  ready: true,
  response: true,
  agent_start: true,
  agent_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_end: true,
  tool_execution_update: true,
  queue_update: true,
  extension_ui_request: true,
  prompt_result: true,
  session_settled: true,
  available_commands_update: true,
  command_output: true,
  notice: true,
  rpc_chunk: true,
  btw_delta: true,
  btw_record: true,
};

export function isKnownFrame(frame: Frame): frame is KnownFrame {
  return Object.prototype.hasOwnProperty.call(KNOWN_FRAME_TYPES, frame.type);
}

export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: SupportedImageMimeType;
}

export interface PromptCommand {
  type: 'prompt';
  id: string;
  message: string;
  images?: ImageContent[];
  streamingBehavior?: 'followUp';
}

export interface AbortCommand {
  type: 'abort';
  id: string;
}

export type QueueKind = 'followUp' | 'steering';

export interface RemoveQueuedMessageCommand {
  type: 'remove_queued_message';
  id: string;
  message: string;
  queue: QueueKind;
}

// Moves the first matching queued follow-up to the end of the steering queue -- atomic, keeps
// attachments, no reprocessing, no duplicate.
export interface PromoteQueuedMessageCommand {
  type: 'promote_queued_message';
  id: string;
  message: string;
}

export interface NewSessionCommand {
  type: 'new_session';
  id: string;
}

export interface SwitchSessionCommand {
  type: 'switch_session';
  id: string;
  sessionPath: string;
}

export interface GetStateCommand {
  type: 'get_state';
  id: string;
}

export interface GetMessagesCommand {
  type: 'get_messages';
  id: string;
}

/** `limit` is required here (unbounded is exactly what `get_messages` is for). */
export interface GetMessagesPageCommand {
  type: 'get_messages_page';
  id: string;
  limit: number;
  cursor?: string;
}

export interface NegotiateProtocolCommand {
  type: 'negotiate_protocol';
  id: string;
  protocolVersion: number;
}

export type ExtensionUiResponseFrame = ExtensionUiResponseCommand & ExtensionUiAnswer;

export interface GetAvailableCommandsCommand {
  type: 'get_available_commands';
  id: string;
}

/** `text` is the whole draft and `cursor` a UTF-16 offset into it. */
export interface PredictWordCommand {
  type: 'predict_word';
  id: string;
  text: string;
  cursor: number;
}

/** Sent once per shown-then-resolved suggestion. */
export interface PredictWordFeedbackCommand {
  type: 'predict_word_feedback';
  id: string;
  text: string;
  cursor: number;
  suggestion: string;
  accepted: boolean;
}

export interface BtwCommand {
  type: 'btw';
  id: string;
  question: string;
  recordId?: string;
}

export interface BtwCancelCommand {
  type: 'btw_cancel';
  id: string;
}

export interface GetBtwHistoryCommand {
  type: 'get_btw_history';
  id: string;
}

export type RpcCommand =
  | PromptCommand
  | AbortCommand
  | RemoveQueuedMessageCommand
  | PromoteQueuedMessageCommand
  | NewSessionCommand
  | SwitchSessionCommand
  | GetStateCommand
  | GetMessagesCommand
  | GetMessagesPageCommand
  | NegotiateProtocolCommand
  | ExtensionUiResponseFrame
  | GetAvailableCommandsCommand
  | PredictWordCommand
  | PredictWordFeedbackCommand
  | BtwCommand
  | BtwCancelCommand
  | GetBtwHistoryCommand;
