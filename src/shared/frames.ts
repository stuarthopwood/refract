// The subset of OMP's rpc-ui wire protocol Pinion reads and writes, per
// specs/001-core-session-workspace/contracts/omp-usage.md ("Frames Pinion consumes",
// "Message parts", "Dialogs") and specs/001-core-session-workspace/contracts/ipc.md.
// Shapes not pinned down by those docs were cross-checked against real recorded frames
// from docs/spike/resume-probe.mjs (see the ambiguity notes below).

// ---------------------------------------------------------------------------
// Message content parts (the pieces Pinion reads out of OMP's own messages)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OMP messages (as returned by get_messages and carried on message_start/end)
// ---------------------------------------------------------------------------

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
  // Provider bookkeeping (model, usage, stopReason, providerPayload, ...) Pinion does not read.
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

// ---------------------------------------------------------------------------
// Slash commands (available_commands_update / chat.commands)
// ---------------------------------------------------------------------------

export interface SlashCommandDescriptor {
  name: string;
  description: string;
  /** Other names that invoke the same command (observed on the real wire, e.g. `model`'s `models`). */
  aliases?: string[];
  input?: { hint: string };
  subcommands?: SlashCommandDescriptor[];
}

// ---------------------------------------------------------------------------
// Dialogs (extension_ui_request / extension_ui_response), per "Dialogs"
// ---------------------------------------------------------------------------

export type ExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text'
  | 'open_url'
  | 'cancel';

export interface ExtensionUiRequestFrame {
  type: 'extension_ui_request';
  id: string;
  method: ExtensionUiMethod;
  title?: string;
  options?: string[];
  optionDetails?: { description?: string }[];
  message?: string;
  notifyType?: 'info' | 'warning' | 'error';
  /** Present only on `method: 'cancel'`: the `id` of the dialog being withdrawn. */
  targetId?: string;
  // setWidget/setStatus/setTitle/set_editor_text/open_url carry method-specific fields
  // this contract does not enumerate; Pinion ignores those methods entirely.
  [key: string]: unknown;
}

export type ExtensionUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface ExtensionUiResponseCommand {
  type: 'extension_ui_response';
  id: string;
}

// ---------------------------------------------------------------------------
// Response payloads Pinion depends on for reattach verification (data-model.md)
// ---------------------------------------------------------------------------

export interface GetStateResponseData {
  sessionFile: string;
  sessionId: string;
  messageCount: number;
  isSettled: boolean;
  [key: string]: unknown;
}

export interface GetMessagesResponseData {
  messages: OmpMessage[];
}

export interface SwitchSessionResponseData {
  cancelled: boolean;
}

export interface GetAvailableCommandsResponseData {
  commands: SlashCommandDescriptor[];
}

// ---------------------------------------------------------------------------
// Frames Pinion consumes
// ---------------------------------------------------------------------------

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
  /** Shared by every message_start/message_update/message_end for the same message; unique
   * within the RPC process (verified against a real capture). */
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

export interface QueueUpdateFrame {
  type: 'queue_update';
  followUp: string[];
  steering: string[];
}

export interface PromptResultFrame {
  type: 'prompt_result';
  id: string;
  agentInvoked: boolean;
  status: 'completed' | 'aborted' | 'error';
  sessionSettled?: boolean;
  error?: string;
}

export interface SessionSettledFrame {
  type: 'session_settled';
}

export interface AvailableCommandsUpdateFrame {
  type: 'available_commands_update';
  commands: SlashCommandDescriptor[];
}

/**
 * Local slash-command output (agentInvoked: false); can arrive before or after the
 * prompt's own response. contracts/omp-usage.md does not enumerate exact payload
 * fields ("text via `command_output`"), so this is read defensively: prefer `text`,
 * fall back to `message`, tolerate anything else via the index signature.
 */
export interface CommandOutputFrame {
  type: 'command_output';
  text?: string;
  message?: string;
  [key: string]: unknown;
}

export interface NoticeFrame {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * v1 frames are capped at maxFrameBytes; a payload larger than that (e.g. get_state's
 * systemPrompt/dumpTools) arrives split across rpc_chunk frames sharing a chunkId.
 * Pinion buffers each `index` (base64-decoded), and once all `count` parts are present,
 * concatenates and validates the result against `byteLength` before parsing it as the
 * real frame.
 */
export interface RpcChunkFrame {
  type: 'rpc_chunk';
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string; // base64
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
  | QueueUpdateFrame
  | ExtensionUiRequestFrame
  | PromptResultFrame
  | SessionSettledFrame
  | AvailableCommandsUpdateFrame
  | CommandOutputFrame
  | NoticeFrame
  | RpcChunkFrame;

/** Anything OMP sends whose `type` Pinion does not recognise. Never throw on it. */
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
  queue_update: true,
  extension_ui_request: true,
  prompt_result: true,
  session_settled: true,
  available_commands_update: true,
  command_output: true,
  notice: true,
  rpc_chunk: true,
};

export function isKnownFrame(frame: Frame): frame is KnownFrame {
  return Object.prototype.hasOwnProperty.call(KNOWN_FRAME_TYPES, frame.type);
}

// ---------------------------------------------------------------------------
// Commands Pinion sends, per "Commands Pinion sends"
// ---------------------------------------------------------------------------

export interface PromptCommand {
  type: 'prompt';
  id: string;
  message: string; // never `text` (constitution II)
  streamingBehavior?: 'followUp'; // present when the Session is already working
}

export interface SteerCommand {
  type: 'steer';
  id: string;
  message: string;
}

export interface AbortCommand {
  type: 'abort';
  id: string;
}

export interface RemoveQueuedMessageCommand {
  type: 'remove_queued_message';
  id: string;
  message: string;
  queue: 'followUp';
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

export type RpcCommand =
  | PromptCommand
  | SteerCommand
  | AbortCommand
  | RemoveQueuedMessageCommand
  | NewSessionCommand
  | SwitchSessionCommand
  | GetStateCommand
  | GetMessagesCommand
  | NegotiateProtocolCommand
  | ExtensionUiResponseFrame
  | GetAvailableCommandsCommand;
