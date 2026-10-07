// The subset of OMP's rpc-ui wire protocol Refract reads and writes, per
// specs/001-core-session-workspace/contracts/omp-usage.md ("Frames Refract consumes",
// "Message parts", "Dialogs") and specs/001-core-session-workspace/contracts/ipc.md.
// Shapes not pinned down by those docs were cross-checked against real recorded frames
// from docs/spike/resume-probe.mjs (see the ambiguity notes below).

// ---------------------------------------------------------------------------
// Message content parts (the pieces Refract reads out of OMP's own messages)
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
  /** Carries structured payloads for a recognised `customType`, e.g. a batch `task()` run's
   * `async-result` (`{jobs: [...]}, FINDINGS item 22(e)) or a (best-effort, FINDINGS item
   * 22(f) left this wire shape unconfirmed) subagent-to-parent IRC message. */
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
  // this contract does not enumerate; Refract ignores those methods entirely.
  [key: string]: unknown;
}

export type ExtensionUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface ExtensionUiResponseCommand {
  type: 'extension_ui_response';
  id: string;
}

// ---------------------------------------------------------------------------
// Response payloads Refract depends on for reattach verification (data-model.md)
// ---------------------------------------------------------------------------

export interface GetStateResponseData {
  sessionFile: string;
  sessionId: string;
  messageCount: number;
  isSettled: boolean;
  /** T056/T062, FINDINGS item 30: the live model, when `get_state` reports one (omitted for a
   * Session with no model resolved yet). `name` is the display name, distinct from `id`. */
  model?: { provider: string; id: string; name?: string };
  /** T056/T062, FINDINGS item 30: the live thinking level/reasoning effort, when `get_state`
   * reports one; OMP's own `ThinkingLevel` string union (`"off" | "inherit" | "minimal" |
   * "low" | "medium" | "high" | "xhigh" | "max"`), carried verbatim. */
  thinkingLevel?: string;
  /** Spec 004 FR-003, FINDINGS item 34: `percent` is computed and reported by OMP itself, never
   * derived by Refract. Confirmed present both before and after a turn runs. */
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  /** Spec 004 FR-021, FINDINGS item 35: the agent's own task list, one entry per phase. `status`
   * observed values: 'completed' | 'in_progress' | 'pending' (carried as a plain string, not a
   * narrowed union, since an unobserved future value must never throw). */
  todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
  [key: string]: unknown;
}

export interface GetMessagesResponseData {
  messages: OmpMessage[];
}

export interface SwitchSessionResponseData {
  cancelled: boolean;
}

/** `get_subagents` (issue #489, PLAN.md row A2c; confirmed live, `docs/spike/get-subagents-probe.mjs`,
 * 2026-10-07, omp 18.8.0): one entry per subagent THIS PROCESS's own registry still tracks --
 * confirmed scoped to the current process only, never replayed from a Conversation's history onto
 * a freshly attached process (a fresh process's own `get_subagents` returned `{ subagents: [] }`
 * even seconds after a hard-killed process's own genuinely-running subagent, same Conversation
 * file, same `switch_session` attach SessionAgent.ts uses). `id` is the subagent's own bare name,
 * the same value `tool_execution_update`'s `progress[].id` carries (`contracts/omp-usage.md`
 * section (c)); only `id` is read by Refract, the rest is left loose. */
export interface GetSubagentsResponseData {
  subagents: Array<{ id: string; status: string; [key: string]: unknown }>;
}

export interface GetAvailableCommandsResponseData {
  commands: SlashCommandDescriptor[];
}

/** `predict_word` (T103, FR-058): `suffix` is `null` whenever the server's own gating
 * (cursor mid-word, not at the end of its line, path-shaped, or slash-command-shaped) or an
 * unavailable prediction engine yields no suggestion (rpc.md "Word prediction"). */
export interface PredictWordResponseData {
  suffix: string | null;
}

// ---------------------------------------------------------------------------
// Frames Refract consumes
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

/** Spec 004 FR-007, FR-017 to FR-020, FINDINGS item 36 (extends C6): live progress for a batch
 * `task()` call, sent for the `task` tool's own `toolCallId` with no subscription needed. Each
 * `progress[]` entry is keyed by `id`, confirmed stable and equal to that subagent's own `name`
 * from the originating `tasks[]` entry. `recentTools`/`recentOutput` grow incrementally as the
 * subagent runs -- the per-subagent live stream this spec's panel reads. */
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
 * Refract buffers each `index` (base64-decoded), and once all `count` parts are present,
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
  | ToolExecutionUpdateFrame
  | QueueUpdateFrame
  | ExtensionUiRequestFrame
  | PromptResultFrame
  | SessionSettledFrame
  | AvailableCommandsUpdateFrame
  | CommandOutputFrame
  | NoticeFrame
  | RpcChunkFrame;

/** Anything OMP sends whose `type` Refract does not recognise. Never throw on it. */
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
};

export function isKnownFrame(frame: Frame): frame is KnownFrame {
  return Object.prototype.hasOwnProperty.call(KNOWN_FRAME_TYPES, frame.type);
}

// ---------------------------------------------------------------------------
// Commands Refract sends, per "Commands Refract sends"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Composer attachments (spec 009): the wire-level shape OMP's own `images` field on `prompt`/
// `steer` accepts (research.md Decisions 1-2). Refract only ever sends base64 + mimeType; it
// never sets `detail` or `providerFile` (OpenAI-only/host-builds-this, respectively -- neither
// applies to a renderer-pasted clipboard image).
// ---------------------------------------------------------------------------

export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageContent {
  type: 'image';
  data: string; // base64; the only channel OMP accepts (research.md Decision 2)
  mimeType: SupportedImageMimeType;
}

export interface PromptCommand {
  type: 'prompt';
  id: string;
  message: string; // never `text` (constitution II)
  images?: ImageContent[]; // spec 009, FR-006
  streamingBehavior?: 'followUp'; // present when the Session is already working
}

export interface SteerCommand {
  type: 'steer';
  id: string;
  message: string;
  images?: ImageContent[]; // spec 009, FR-006, FR-017
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

/** Issue #489, PLAN.md row A2c: polled once right after an attach/resume's `switch_session` to
 * seed `runtime.subagents` for any subagent the reloaded transcript still remembers as `running`
 * (`SessionAgent.seedOrphanedSubagents`). */
export interface GetSubagentsCommand {
  type: 'get_subagents';
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

/** Ghost-text composer completion (T103, FR-058; rpc.md "Word prediction"). `text` is the
 * whole draft and `cursor` a UTF-16 offset into it. */
export interface PredictWordCommand {
  type: 'predict_word';
  id: string;
  text: string;
  cursor: number;
}

/** Sent once per shown-then-resolved suggestion (`accepted: true` on Tab, `false` on dismiss
 * or an invalidating edit); no response payload on success. */
export interface PredictWordFeedbackCommand {
  type: 'predict_word_feedback';
  id: string;
  text: string;
  cursor: number;
  suggestion: string;
  accepted: boolean;
}

export type RpcCommand =
  | PromptCommand
  | SteerCommand
  | AbortCommand
  | RemoveQueuedMessageCommand
  | NewSessionCommand
  | SwitchSessionCommand
  | GetStateCommand
  | GetSubagentsCommand
  | GetMessagesCommand
  | NegotiateProtocolCommand
  | ExtensionUiResponseFrame
  | GetAvailableCommandsCommand
  | PredictWordCommand
  | PredictWordFeedbackCommand;
