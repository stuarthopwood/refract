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

export function registerChat(manager: SessionManager): void {
  ipcMain.handle(IPC_REQUESTS.CHAT_SEND, async (_event, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_SEND} expects (sessionId, text) strings`);
    }
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
      const result = await agent.send(text);
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

  ipcMain.handle(IPC_REQUESTS.CHAT_REMOVE_QUEUED, async (_event, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      return invalidArgument(`${IPC_REQUESTS.CHAT_REMOVE_QUEUED} expects (sessionId, text) strings`);
    }
    if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
    try {
      const result = await manager.getOrCreateAgent(sessionId).removeQueued(text);
      return { ok: true, value: result };
    } catch (err) {
      return mapChatError(err);
    }
  });

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
}
