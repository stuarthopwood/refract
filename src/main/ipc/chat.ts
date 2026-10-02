// IPC handlers for `chat.*` (contracts/ipc.md "Chat", tasks.md T024 + T028's `chat.answer`).
// `chat.send` validates a leading `/name` against the Session's latest `available_commands_update`
// list plus Refract's native set (constitution I); unknown names are refused locally and nothing
// is sent. `/new` is the one native command implemented so far, mapped to
// `SessionAgent.startNewConversation` (the same RPC `new_session` T027 uses); every other native
// command is recognised (not `unknown-command`) but not yet implemented.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { ChatAnswer, Result } from '../../shared/ipc';
import type { SlashCommandDescriptor } from '../../shared/frames';
import { AgentNotRunningError, PromptFailedError, ReattachFailedError, SessionNotIdleError } from '../omp/errors';
import { invalidArgument, mapSessionThrown, notFound } from './util';
import type { SessionManager } from '../SessionManager';

// Constitution I: "Refract ... supplies natively only the commands absent over RPC: /plan,
// /fork, /resume, /new, /settings, /pause, /plan-review, and /btw."
const NATIVE_COMMANDS: Record<string, true> = {
  new: true,
  resume: true,
  plan: true,
  fork: true,
  settings: true,
  pause: true,
  'plan-review': true,
  btw: true,
};

/** `chat.send`/`chat.stop`/`chat.removeQueued`/`chat.sendNow` all drive an already-attached
 * process (never a Conversation reattach), so their default code is `prompt-failed`, not
 * `mapSessionThrown`'s `reattach-failed`. */
function mapChatError(err: unknown): Result<never> {
  if (err instanceof AgentNotRunningError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof PromptFailedError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) } };
}

function collectCommandNames(commands: readonly SlashCommandDescriptor[]): Set<string> {
  const names = new Set<string>();
  for (const command of commands) {
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}

/** The command name in a leading `/name ...`, or `undefined` for ordinary text. */
function parseSlashCommand(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  return /^\/(\S+)/.exec(trimmed)?.[1];
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

    const commandName = parseSlashCommand(text);
    if (commandName !== undefined) {
      if (commandName === 'new') {
        try {
          await agent.startNewConversation();
          return { ok: true, value: { queued: false } };
        } catch (err) {
          return mapSessionThrown(err);
        }
      }
      if (Object.prototype.hasOwnProperty.call(NATIVE_COMMANDS, commandName)) {
        return { ok: false, error: { code: 'unknown-command', message: `Unknown command: /${commandName}` } };
      }
      if (!collectCommandNames(agent.availableCommands).has(commandName)) {
        return { ok: false, error: { code: 'unknown-command', message: `Unknown command: /${commandName}` } };
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
