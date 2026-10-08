// IPC handlers for `chat.*` (contracts/ipc.md "Chat", tasks.md T024 + T028's `chat.answer`).
// `chat.send` validates a leading `/name [subcommand]` against the Session's latest
// `available_commands_update` list (already filtered + subcommand-pruned by
// `src/shared/slash-commands.ts`'s `filterSupportedCommands`, applied once in
// `SessionAgent`'s `available_commands_update` handler) plus Refract's native reserved set
// (constitution I); anything else -- an unrecognized name, an unverified subcommand of an
// otherwise-allowed name, or any trailing argument text beyond a verified bare name/subcommand
// -- is refused locally via `classifySlashInvocation` and nothing is sent (Critical remediation,
// issue #129: a subcommand the probe never verified, e.g. `/todo copy`, used to still reach OMP
// under its allowed parent name). A recognized command given unverified arguments gets its own
// `unsupported-arguments` refusal instead of being folded into `unknown-command` (FR-033 reserves
// "unknown" for a command hidden entirely under FR-032, not a listed one with bad arguments).
// `/new` is the one native command implemented so far, mapped
// to `SessionAgent.startNewConversation` (the same RPC `new_session` T027 uses); every other
// native command name is refused with `unknown-command` so it is never silently forwarded to
// OMP, even if a future OMP version adds a real `/plan`, `/fork`, `/btw`, etc. to its own
// `available_commands` (constitution I/II -- these must stay client-side native behaviors).

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { ChatAnswer, Result } from '../../shared/ipc';
import { classifySlashInvocation, NATIVE_RESERVED_COMMANDS, parseSlashCommand } from '../../shared/slash-commands';
import { AgentNotRunningError, PromptFailedError, ReattachFailedError, SessionNotIdleError } from '../omp/errors';
import { validateImageAttachment } from '../omp/images';
import type { ImageContent } from '../../shared/frames';
import { invalidArgument, mapSessionThrown, notFound } from './util';
import type { SessionManager } from '../SessionManager';

/** `chat.send`/`chat.stop`/`chat.removeQueued`/`chat.sendNow` all drive an already-attached
 * process (never a Conversation reattach), so their default code is `prompt-failed`, not
 * `mapSessionThrown`'s `reattach-failed`. */
function mapChatError(err: unknown): Result<never> {
  if (err instanceof AgentNotRunningError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof PromptFailedError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) } };
}

function isChatAnswer(value: unknown): value is ChatAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.approve === 'boolean' || typeof v.value === 'string' || typeof v.confirmed === 'boolean' || v.cancelled === true;
}

/** `images` (spec 009, FR-018, contracts/ipc.md): accepted as `unknown` off the wire like every
 * other argument here, shape-checked, then independently re-validated entry by entry (mime type,
 * decoded byte size, real magic bytes) before anything is ever forwarded to `SessionAgent` -- the
 * renderer's own paste-time check is never trusted alone (constitution Principle V). Runs in the
 * same place the existing `sessionId`/argument-shape checks already do, additive to them, never
 * replacing their failure modes; the first failing entry's code is returned and nothing is sent.
 * `undefined` (no `images` argument at all) is valid and carries no images. Used by `CHAT_SEND`
 * only -- `CHAT_SEND_NOW` no longer accepts an `images` argument (High remediation: a resend's own
 * images are recorded and resent by `SessionAgent` itself, never supplied by the caller).
 *
 * Critical/High remediation (code-reviewer): builds a FRESH `ImageContent` containing ONLY the
 * three validated fields, never `candidate as unknown as ImageContent`. The old cast forwarded the
 * renderer's whole object unchanged -- a compromised/buggy renderer could attach extra fields
 * (`providerFile`, `url`, `detail`) that OMP's own real handling acts on, reaching a privileged
 * provider-file/remote-URL fetch despite every shape/mime/size check here passing. Also rejects a
 * zero-length `data` string, which the old checks never excluded. */
function parseImagesArgument(images: unknown): { ok: true; value: ImageContent[] | undefined } | Result<never> {
  if (images === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(images)) {
    return invalidArgument(`${IPC_REQUESTS.CHAT_SEND} expects images to be an array when provided`);
  }
  const parsed: ImageContent[] = [];
  for (const entry of images) {
    if (typeof entry !== 'object' || entry === null) {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND}: each image must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.type !== 'image' || typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND}: each image must be { type: 'image', data: string, mimeType: string }`);
    }
    if (candidate.data.length === 0) {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND}: image data must not be empty`);
    }
    const image: ImageContent = { type: 'image', data: candidate.data, mimeType: candidate.mimeType as ImageContent['mimeType'] };
    const validation = validateImageAttachment(image);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: validation.code,
          message:
            validation.code === 'unsupported-image-type'
              ? `Unsupported image type: ${image.mimeType}`
              : 'Image exceeds the 20 MiB limit',
        },
      };
    }
    parsed.push(image);
  }
  return { ok: true, value: parsed };
}

export function registerChat(manager: SessionManager): void {
  ipcMain.handle(IPC_REQUESTS.CHAT_SEND, async (_event, sessionId: unknown, text: unknown, images: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND} expects (sessionId, text) strings`);
    }
    const parsedImages = parseImagesArgument(images);
    if (!parsedImages.ok) return parsedImages;
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    const agent = manager.getOrCreateAgent(sessionId);

    const parsed = parseSlashCommand(text);
    if (parsed !== undefined) {
      if (parsed.name === 'new' && parsed.rest === '') {
        try {
          await agent.startNewConversation();
          return { ok: true, value: { queued: false } };
        } catch (err) {
          return mapSessionThrown(err);
        }
      }
      // Refuse the command locally, without forwarding anything to OMP, when either: the name
      // is one of Refract's own native/reserved commands (never forwarded even if OMP later
      // recognizes it), or this exact invocation (bare name, or name + subcommand, with no
      // trailing argument text) is not one `agent.availableCommands` (already filtered +
      // pruned) actually lists.
      if (Object.prototype.hasOwnProperty.call(NATIVE_RESERVED_COMMANDS, parsed.name)) {
        return {
          ok: false,
          error: { code: 'unknown-command', message: `Unknown command: /${parsed.name}${parsed.rest ? ` ${parsed.rest}` : ''}` },
        };
      }
      const classification = classifySlashInvocation(parsed, agent.availableCommands);
      if (classification === 'unknown-command') {
        return {
          ok: false,
          error: { code: 'unknown-command', message: `Unknown command: /${parsed.name}${parsed.rest ? ` ${parsed.rest}` : ''}` },
        };
      }
      if (classification === 'unsupported-arguments') {
        return {
          ok: false,
          error: {
            code: 'unsupported-arguments',
            message: `/${parsed.name} doesn't support arguments yet. Try /${parsed.name} on its own.`,
          },
        };
      }
      // A real OMP-side command (from available_commands_update): fall through and forward it
      // as a normal prompt below.
    }

    try {
      const result = await agent.send(text, parsedImages.value);
      return { ok: true, value: result };
    } catch (err) {
      return mapChatError(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.CHAT_STOP, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.CHAT_STOP} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      await manager.getOrCreateAgent(sessionId).stop();
      return { ok: true, value: undefined };
    } catch (err) {
      return mapChatError(err);
    }
  });

  // Issue #540: `queue` carries which of OMP's two queues the chip actually belongs to --
  // the old hard-coded `'followUp'` made a steering chip's Remove always report
  // `removed: false` (OMP never had it in that queue), so it could never be removed.
  ipcMain.handle(IPC_REQUESTS.CHAT_REMOVE_QUEUED, async (_event, sessionId: unknown, text: unknown, queue: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string' || (queue !== 'followUp' && queue !== 'steering')) {
      return invalidArgument(`${IPC_REQUESTS.CHAT_REMOVE_QUEUED} expects (sessionId, text, queue) with queue 'followUp' or 'steering'`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const result = await manager.getOrCreateAgent(sessionId).removeQueued(text, queue);
      return { ok: true, value: result };
    } catch (err) {
      return mapChatError(err);
    }
  });

  // Issue #540: no `images` argument here at all -- OMP keeps the queued message's own images
  // with it (`promote_queued_message` moves the existing message, attachments included,
  // rather than reprocessing it), never whatever the caller's composer happens to have
  // pending right now.
  ipcMain.handle(IPC_REQUESTS.CHAT_SEND_NOW, async (_event, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND_NOW} expects (sessionId, text) strings`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const result = await manager.getOrCreateAgent(sessionId).sendNow(text);
      return { ok: true, value: result };
    } catch (err) {
      return mapChatError(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.CHAT_ANSWER, async (_event, sessionId: unknown, requestId: unknown, answer: unknown) => {
    if (typeof sessionId !== 'string' || typeof requestId !== 'string' || !isChatAnswer(answer)) {
      return invalidArgument(`${IPC_REQUESTS.CHAT_ANSWER} expects (sessionId, requestId, answer)`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      await manager.getOrCreateAgent(sessionId).answerRequest(requestId, answer);
      return { ok: true, value: undefined };
    } catch (err) {
      return notFound(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(IPC_REQUESTS.CHAT_COMMANDS, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return invalidArgument(`${IPC_REQUESTS.CHAT_COMMANDS} expects a string sessionId`);
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    return { ok: true, value: [...manager.getOrCreateAgent(sessionId).availableCommands] };
  });

  // T103, FR-058: ghost-text composer completion. `getOrCreateAgent` only looks up (or lazily
  // constructs, never starts) the Session's `SessionAgent`; `predictWord`/`predictWordFeedback`
  // themselves check for an already-running live `OmpProcess` and resolve to `null`/a no-op
  // instead of starting one (a cold shared prediction daemon's first call can take up to ~2
  // minutes, FINDINGS item 28, and a keystroke in a stopped Session's composer must never
  // trigger that). Neither ever throws, so a failure here is never surfaced as a chat error.
  ipcMain.handle(IPC_REQUESTS.CHAT_PREDICT_WORD, async (_event, sessionId: unknown, text: unknown, cursor: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string' || typeof cursor !== 'number') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_PREDICT_WORD} expects (sessionId, text, cursor)`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    const suffix = await manager.getOrCreateAgent(sessionId).predictWord(text, cursor);
    return { ok: true, value: suffix };
  });

  ipcMain.handle(
    IPC_REQUESTS.CHAT_PREDICT_WORD_FEEDBACK,
    async (_event, sessionId: unknown, text: unknown, cursor: unknown, suggestion: unknown, accepted: unknown) => {
      if (
        typeof sessionId !== 'string' ||
        typeof text !== 'string' ||
        typeof cursor !== 'number' ||
        typeof suggestion !== 'string' ||
        typeof accepted !== 'boolean'
      ) {
        return invalidArgument(`${IPC_REQUESTS.CHAT_PREDICT_WORD_FEEDBACK} expects (sessionId, text, cursor, suggestion, accepted)`);
      }
      if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
      await manager.getOrCreateAgent(sessionId).predictWordFeedback(text, cursor, suggestion, accepted);
      return { ok: true, value: undefined };
    }
  );

  // Spec 004 FR-017 to FR-020: tells main which subagent's stream to forward as
  // `subagent:patch`; `null` stops forwarding (panel closed, or no subagent selected).
  ipcMain.handle(IPC_REQUESTS.CHAT_SET_VISIBLE_SUBAGENT, async (_event, sessionId: unknown, subagentId: unknown) => {
    if (typeof sessionId !== 'string' || (subagentId !== null && typeof subagentId !== 'string')) {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SET_VISIBLE_SUBAGENT} expects (sessionId, subagentId | null)`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    manager.getOrCreateAgent(sessionId).setVisibleSubagent(subagentId);
    return { ok: true, value: undefined };
  });

  // Spec 004 FR-018: full current stream for one subagent, for when the panel first selects it,
  // before patches arrive. `not-found` for an id that does not match a SubagentSummary of the
  // current turn.
  ipcMain.handle(IPC_REQUESTS.CHAT_SUBAGENT_SNAPSHOT, async (_event, sessionId: unknown, subagentId: unknown) => {
    if (typeof sessionId !== 'string' || typeof subagentId !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SUBAGENT_SNAPSHOT} expects (sessionId, subagentId) strings`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      return { ok: true, value: manager.getOrCreateAgent(sessionId).subagentSnapshot(subagentId) };
    } catch (err) {
      return notFound(err instanceof Error ? err.message : String(err));
    }
  });
}
