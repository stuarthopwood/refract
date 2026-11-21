// Serve mode for the fake `omp` (#1861): a tape ending in `{"__serve__":"conversations"}` hands later commands to this
// responder, because a linear tape cannot start, switch and refuse Conversations any number of times.
// Files go in `<REFRACT_FAKE_OMP_SERVE_ROOT>/<cwd basename>/`, named like real omp files; `serve-procs.jsonl` maps pid to dir.
// A `prompt` containing `HOLD` stays open until a `__serve_settle__` call line or `abort_and_restore_queue`.
// `REFRACT_FAKE_OMP_NEW_SESSION_REFUSALS` / `..._PROMPT_AFTER_NEW_REFUSALS`: scratch files holding N refusals to make.
// `REFRACT_FAKE_OMP_PROMPT_REFUSALS` is the same for any `prompt`; a prompt sent while a turn is held answers `queued`, as omp does (#2013).

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MODEL = { provider: 'example-provider', id: 'example-model-1', name: 'Example Model One' };

/** `2026-11-19T10:15:30.123Z` as omp names files: `:` and `.` become `-`. */
export const fileStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

export function createServe({ emit, root, cwd, pid, env }) {
  const dir = path.join(root, path.basename(cwd));
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(root, 'serve-procs.jsonl'), `${JSON.stringify({ pid, cwd, dir })}\n`);
  let lastMs = 0;
  let counter = 0;
  let current = null;
  let messageCount = 0;
  let held = false;
  let turnId = null;

  const newFile = () => {
    lastMs = Math.max(Date.now(), lastMs + 1);
    counter += 1;
    const file = path.join(dir, `${fileStamp(lastMs)}_p${pid}c${counter}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'title', title: `Conversation ${counter}` })}\n`);
    return file;
  };
  current = newFile();

  const takeFrom = (file) => {
    if (!file || !existsSync(file)) return false;
    const left = Number(readFileSync(file, 'utf8').trim()) || 0;
    if (left <= 0) return false;
    writeFileSync(file, String(left - 1));
    return true;
  };
  const takeRefusal = () => takeFrom(env.REFRACT_FAKE_OMP_NEW_SESSION_REFUSALS);
  let refuseNextPrompt = false;

  const settle = (status) => {
    held = false;
    if (status === 'completed') {
      emit({ type: 'message_start', messageId: `msg-a${messageCount}`, message: { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 0 } });
      emit({ type: 'message_end', messageId: `msg-a${messageCount}`, message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], timestamp: 0 } });
    }
    messageCount += 1;
    emit({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 });
    emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: false });
    emit({ id: turnId, type: 'prompt_result', agentInvoked: true, status, sessionSettled: true });
    emit({ type: 'session_settled' });
  };

  const handle = (cmd) => {
    const reply = (extra = {}) => emit({ id: cmd.id, type: 'response', command: cmd.type, success: true, ...extra });
    const refuse = (error) => emit({ id: cmd.id, type: 'response', command: cmd.type, success: false, error });
    switch (cmd.type) {
      case 'negotiate_protocol':
        return reply({ data: { protocolVersion: 2 } });
      case 'set_ask_dialog':
        return reply({ data: { enabled: true } });
      case 'get_state':
        return reply({ data: { sessionFile: current, sessionId: `sess-1861-${pid}`, messageCount, isSettled: !held, model: MODEL, thinkingLevel: 'medium' } });
      case 'get_messages_page':
      case 'get_messages':
        return reply({ data: { messages: [], totalMessages: 0 } });
      case 'new_session':
        if (takeRefusal()) return refuse('fixture refused new_session');
        current = newFile();
        messageCount = 0;
        refuseNextPrompt = takeFrom(env.REFRACT_FAKE_OMP_PROMPT_AFTER_NEW_REFUSALS);
        return reply({ data: { cancelled: false } });
      case 'switch_session':
        if (typeof cmd.sessionPath !== 'string' || !existsSync(cmd.sessionPath)) return refuse('no such Conversation file');
        current = cmd.sessionPath;
        messageCount = 1;
        return reply({ data: { cancelled: false } });
      case 'prompt': {
        if (refuseNextPrompt) {
          refuseNextPrompt = false;
          return refuse('fixture refused the first prompt after new_session');
        }
        if (takeFrom(env.REFRACT_FAKE_OMP_PROMPT_REFUSALS)) return refuse('fixture refused the prompt');
        turnId = cmd.id;
        reply(held ? { queued: true } : {});
        const text = typeof cmd.message === 'string' ? cmd.message : '';
        emit({ type: 'agent_start' });
        const message = { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
        emit({ type: 'message_start', messageId: `msg-u${messageCount}`, message });
        emit({ type: 'message_end', messageId: `msg-u${messageCount}`, message });
        appendFileSync(current, `${JSON.stringify({ type: 'message', message })}\n`);
        messageCount += 1;
        if (text.includes('HOLD')) held = true;
        else settle('completed');
        return;
      }
      case 'abort_and_restore_queue':
      case 'abort':
        reply({ data: { steering: [], followUp: [] } });
        if (held) settle('aborted');
        return;
      default:
        return reply();
    }
  };

  return { handle, settleHeld: () => held && settle('completed'), dir };
}
