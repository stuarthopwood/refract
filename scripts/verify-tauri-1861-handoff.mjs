// #1861 user story 1 (spec.md): an agent hands over to a fresh Conversation of its own Session. Every scenario gets a
// Session of its own, holds a turn open (the fake omp keeps a `HOLD` prompt working until the check settles it or the
// user stops it), and calls the Host tool as that Session's omp process.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const NEW = 'refract_new_conversation';
const SWITCH = 'refract_switch_conversation';
const PROMPT = 'Summary of my work so far.\nNext: finish the parser. Keep this text unchanged.';
const HANDOFF_LABEL = 'Handoff note from the previous Conversation';

const DRAFT = 'An unsent draft the user was typing';

const paneComposer = (s) => `document.querySelector('[data-session-pane="${s.id}"] [aria-label="Message"]')`;

/** Types into the Session's composer without sending. */
async function typeDraft(ctx, s, text) {
  await ctx.cdp.click(paneComposer(s));
  await ctx.cdp.send('Input.insertText', { text });
}

/** What the Session's composer currently holds. */
const draftOf = (ctx, s) => ctx.cdp.evaluate(`${paneComposer(s)}?.value ?? null`);

const idsOf = (rows) => rows.map((c) => c.id);
const currentOf = (rows) => rows.filter((c) => c.isCurrent).map((c) => c.id);

/** The user rows of a Conversation file, read from disk: what omp itself was given. */
function userTextsInFile(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'message' && r.message.role === 'user')
    .map((r) => r.message.content[0].text);
}

const filesOf = (s) => readdirSync(s.sessionDir).filter((f) => f.endsWith('.jsonl')).sort();

async function waitConversations(ctx, s, count) {
  await ctx.cdp.waitFor(`window.refract.conversations.list(${JSON.stringify(s.id)}).then((r) => r.ok && r.value.length === ${count})`, {
    timeoutMs: 20_000,
    label: `${s.id} lists ${count} Conversations`
  });
}

/** The state a queued handoff must leave untouched while it waits: one Conversation, still current, no new_session. */
async function assertNothingStarted(ctx, rec, s, before, what) {
  const ipc = await ctx.conversationsIpc(s.id);
  rec.check(ipc.length === before.ids.length, `${what}: the Session still has ${before.ids.length} Conversation(s).`, `${what}: ${ipc.length} Conversations, expected ${before.ids.length}`);
  rec.check(JSON.stringify(currentOf(ipc)) === JSON.stringify(before.current), `${what}: the current Conversation is unchanged (${before.current[0]}).`, `${what}: current ids ${JSON.stringify(currentOf(ipc))}`);
  rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions, `${what}: omp received no new_session.`, `${what}: new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
  rec.check(filesOf(s).length === before.files, `${what}: no Conversation file was created.`, `${what}: ${filesOf(s).length} files, expected ${before.files}`);
}

async function snapshot(ctx, s) {
  const ipc = await ctx.conversationsIpc(s.id);
  return { ids: idsOf(ipc), current: currentOf(ipc), newSessions: ctx.recvCount('new_session', s.pid), files: filesOf(s).length };
}

/** A Session mid-turn with a queued self-handoff: the precondition of scenarios 2 to 5. */
async function queuedHandoff(ctx, label) {
  const s = await ctx.newSession(label);
  await ctx.holdTurn(s);
  const before = await snapshot(ctx, s);
  const res = await ctx.call(NEW, { session_id: s.id, prompt: PROMPT }, s.pid);
  if (res.isError || res.body.outcome !== 'scheduled') throw new Error(`precondition: handoff not scheduled: ${JSON.stringify(res.body)}`);
  return { s, before, res };
}

const scenarios = [
  {
    name: 'plan3-self-new-runs-on-settle',
    title: 'plan 3: mid-turn new_conversation returns scheduled; on settle a new Conversation exists with the unchanged prompt and the handoff label; panes moved; draft kept',
    async run(ctx, rec) {
      const s = await ctx.newSession('P3');
      await ctx.holdTurn(s);
      const before = await snapshot(ctx, s);
      await typeDraft(ctx, s, DRAFT);
      rec.check((await draftOf(ctx, s)) === DRAFT, 'The unsent draft is in the composer before the handoff.', `composer value ${JSON.stringify(await draftOf(ctx, s))}`);
      const res = await ctx.call(NEW, { session_id: s.id, prompt: PROMPT }, s.pid);
      ctx.evidence('plan3-scheduled.json', { call: { tool: NEW, args: res.args }, result: res.body, before });
      rec.check(!res.isError && res.body.outcome === 'scheduled', 'new_conversation returned outcome "scheduled".', `result: ${JSON.stringify(res)}`);
      rec.check(res.body.id === s.id, 'The result names the caller Session.', `result id ${res.body.id}`);
      await ctx.sleep(1_000);
      await assertNothingStarted(ctx, rec, s, before, 'while queued');
      const row0 = await ctx.row(s.id);
      rec.check(row0?.status === 'working', 'The turn is still running (status working).', `status ${row0?.status}`);
      await ctx.shot('plan3-queued.png');
      ctx.settleTurn(s.pid);
      await waitConversations(ctx, s, before.ids.length + 1).catch(() => {});
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      const ipc = await ctx.conversationsIpc(s.id);
      const fresh = ipc.filter((c) => !before.ids.includes(c.id));
      rec.check(ipc.length === before.ids.length + 1 && fresh.length === 1, 'Exactly one new Conversation exists.', `Conversations ${JSON.stringify(idsOf(ipc))}, before ${JSON.stringify(before.ids)}`);
      rec.check(JSON.stringify(currentOf(ipc)) === JSON.stringify(idsOf(fresh)), 'The new Conversation is the current one.', `current ${JSON.stringify(currentOf(ipc))}`);
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 1, 'omp received exactly one new_session.', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      const row = await ctx.row(s.id);
      const newest = path.join(s.sessionDir, filesOf(s).at(-1));
      const texts = userTextsInFile(newest);
      rec.check(texts.length === 1 && texts[0] === PROMPT, 'The newest Conversation file holds the prompt, byte for byte, as its only user message.', `user messages in ${newest}: ${JSON.stringify(texts)}`);
      rec.check(String(row?.currentConversation ?? '').endsWith(path.basename(newest)), 'The Session row records the new file as its current Conversation.', `currentConversation ${row?.currentConversation}`);
      const transcript = await ctx.transcript(s.id);
      const users = transcript.filter((t) => t.kind === 'user');
      rec.check(users.length === 1 && users[0].text === PROMPT && users[0].source?.kind === 'handoff', 'The panes show the prompt as one user row marked as a handoff note.', `user rows ${JSON.stringify(users)}`);
      const page = await ctx.pageText();
      rec.check(page.includes(HANDOFF_LABEL) && page.includes('Next: finish the parser.'), `The window shows "${HANDOFF_LABEL}" and the prompt text.`, 'the window does not show the handoff label and prompt');
      rec.check((await draftOf(ctx, s)) === DRAFT, 'The unsent draft is still in the composer after the switch.', `composer value ${JSON.stringify(await draftOf(ctx, s))}`);
      ctx.evidence('plan3-runs-on-settle.json', { before, conversations: ipc, newestFile: newest, userMessagesOnDisk: texts, transcriptUserRows: users, sessionRow: row, draftAfter: await draftOf(ctx, s) });
      await ctx.shot('plan3-after-settle.png');
    }
  },
  {
    name: 'plan5-turn-stop-drops-handoff',
    title: 'plan 5: the user stopping the turn while a handoff is queued: nothing happens, and the slot is empty',
    async run(ctx, rec) {
      const { s, before } = await queuedHandoff(ctx, 'H3');
      const stopped = await ctx.cdp.evaluate(`window.refract.chat.stop(${JSON.stringify(s.id)})`);
      rec.check(stopped.ok, 'chat.stop succeeded.', `chat.stop: ${JSON.stringify(stopped)}`);
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      await ctx.sleep(1_500);
      await assertNothingStarted(ctx, rec, s, before, 'after the stop');
      // A later turn that settles must not release a stale slot.
      const sent = await ctx.cdp.evaluate(`window.refract.chat.send(${JSON.stringify(s.id)}, 'A plain follow-up')`);
      rec.check(sent.ok, 'A follow-up message was accepted.', `chat.send: ${JSON.stringify(sent)}`);
      await ctx.sleep(1_500);
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      await assertNothingStarted(ctx, rec, s, before, 'after a later turn settled');
      const page = await ctx.pageText();
      rec.check(!page.includes('Handoff failed'), 'No "Handoff failed" notice appeared.', 'the window shows a Handoff failed notice');
      ctx.evidence('plan5-dropped-on-turn-stop.json', { before, after: await snapshot(ctx, s) });
      await ctx.shot('plan5-after-turn-stop.png');
    }
  },
  {
    name: 'plan6-session-stop-drops-handoff',
    title: 'plan 6: stopping the Session (agent process) while a handoff is queued: nothing happens',
    async run(ctx, rec) {
      const { s, before } = await queuedHandoff(ctx, 'P6');
      const stopped = await ctx.cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(s.id)})`);
      rec.check(stopped.ok, 'sessions.stopAgent succeeded.', `sessions.stopAgent: ${JSON.stringify(stopped)}`);
      await waitForSessionStatus(ctx.cdp, s.id, 'stopped', { timeoutMs: 30_000 });
      await ctx.sleep(2_000);
      await assertNothingStarted(ctx, rec, s, before, 'after the Session stop');
      const page = await ctx.pageText();
      rec.check(!page.includes('Handoff failed'), 'No "Handoff failed" notice appeared.', 'the window shows a Handoff failed notice');
      const notices = (await ctx.transcript(s.id)).filter((t) => t.kind === 'notice' && t.text.startsWith('Handoff failed'));
      rec.check(notices.length === 0, 'The transcript holds no "Handoff failed" notice.', `notices ${JSON.stringify(notices)}`);
      ctx.evidence('plan6-session-stop.json', { before, after: await snapshot(ctx, s), row: await ctx.row(s.id) });
      await ctx.shot('plan6-after-session-stop.png');
    }
  },
  {
    name: 'plan4-second-self-call-refused',
    title: 'plan 4: a second self new_conversation or switch_conversation in the same turn gets invalid_state',
    async run(ctx, rec) {
      const { s, before } = await queuedHandoff(ctx, 'H4');
      const other = `${s.sessionDir}/2026-01-01T00-00-00-000Z_seed-01.jsonl`;
      const message = { role: 'user', content: [{ type: 'text', text: 'Seeded Conversation' }], timestamp: 0 };
      writeFileSync(other, `${JSON.stringify({ type: 'title', title: 'Seed 1' })}\n${JSON.stringify({ type: 'message', message })}\n`);
      const again = await ctx.call(NEW, { session_id: s.id, prompt: 'A different prompt' }, s.pid);
      const swap = await ctx.call(SWITCH, { session_id: s.id, conversation_id: 'seed-01' }, s.pid);
      ctx.evidence('scenario-4-second-refused.json', { newAgain: { args: again.args, isError: again.isError, result: again.body }, switchAfter: { args: swap.args, isError: swap.isError, result: swap.body } });
      rec.check(again.isError && ctx.code(again) === 'invalid_state', 'A second new_conversation returned invalid_state.', `result: ${JSON.stringify(again)}`);
      rec.check(swap.isError && ctx.code(swap) === 'invalid_state', 'switch_conversation returned invalid_state.', `result: ${JSON.stringify(swap)}`);
      rec.check(String(again.body?.error?.message ?? '').includes('already queued'), 'The refusal says a handoff is already queued.', `message: ${again.body?.error?.message}`);
      ctx.settleTurn(s.pid);
      await waitConversations(ctx, s, before.ids.length + 2).catch(() => {});
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      const newest = path.join(s.sessionDir, filesOf(s).at(-1));
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 1, 'Only the first handoff ran: one new_session.', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      rec.check(ctx.recvCount('switch_session', s.pid) === 0, 'The refused switch never reached omp.', `switch_session count ${ctx.recvCount('switch_session', s.pid)}`);
      rec.check(JSON.stringify(userTextsInFile(newest)) === JSON.stringify([PROMPT]), 'The new Conversation received the first prompt, not the refused one.', `newest file user messages ${JSON.stringify(userTextsInFile(newest))}`);
    }
  },
  {
    name: 'plan8a-refused-once-retry-succeeds',
    title: 'plan 8: omp refuses new_session once; the retry succeeds and the new Conversation starts with the prompt',
    async run(ctx, rec) {
      const { s, before } = await queuedHandoff(ctx, 'P8A');
      ctx.setRefusals(1);
      try {
        ctx.settleTurn(s.pid);
        await waitConversations(ctx, s, before.ids.length + 1).catch(() => {});
        await waitForSessionStatus(ctx.cdp, s.id, 'idle');
        await ctx.sleep(1_000);
      } finally {
        ctx.setRefusals(0);
      }
      const ipc = await ctx.conversationsIpc(s.id);
      const fresh = ipc.filter((c) => !before.ids.includes(c.id));
      rec.check(fresh.length === 1 && JSON.stringify(currentOf(ipc)) === JSON.stringify(idsOf(fresh)), 'The retry started one new Conversation and it is current.', `Conversations ${JSON.stringify(idsOf(ipc))}, current ${JSON.stringify(currentOf(ipc))}`);
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 2, 'omp received two new_session commands (refused, then accepted).', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      const newest = path.join(s.sessionDir, filesOf(s).at(-1));
      rec.check(JSON.stringify(userTextsInFile(newest)) === JSON.stringify([PROMPT]), 'The new Conversation holds the unchanged prompt once.', `newest file user messages ${JSON.stringify(userTextsInFile(newest))}`);
      const notices = (await ctx.transcript(s.id)).filter((t) => t.kind === 'notice' && t.text.startsWith('Handoff failed'));
      rec.check(notices.length === 0, 'No "Handoff failed" notice was posted.', `notices ${JSON.stringify(notices)}`);
      ctx.evidence('plan8a-refused-once.json', { before, conversations: ipc, newestFile: newest });
      await ctx.shot('plan8a-retry-succeeded.png');
    }
  },
  {
    name: 'plan8b-refused-twice-notice',
    title: 'plan 8: omp refuses new_session twice; the old Conversation stays current, "Handoff failed" shows, and the next agent turn sees the notice',
    async run(ctx, rec) {
      const { s, before } = await queuedHandoff(ctx, 'P8B');
      ctx.setRefusals(2);
      try {
        ctx.settleTurn(s.pid);
        await waitForSessionStatus(ctx.cdp, s.id, 'idle');
        await ctx.cdp.waitFor(`window.refract.sessions.open(${JSON.stringify(s.id)}).then((r) => r.ok && r.value.runtime.transcript.some((t) => t.kind === 'notice' && t.text.startsWith('Handoff failed:')))`, { timeoutMs: 20_000, label: 'a Handoff failed notice' });
        await ctx.sleep(500);
      } finally {
        ctx.setRefusals(0);
      }
      const transcript = await ctx.transcript(s.id);
      const notices = transcript.filter((t) => t.kind === 'notice' && t.text.startsWith('Handoff failed:'));
      rec.check(notices.length === 1 && notices[0].level === 'error', 'Exactly one error notice starts with "Handoff failed:".', `notices ${JSON.stringify(notices)}`);
      rec.check(String(notices[0]?.text).includes('fixture refused new_session'), `The notice carries the reason: "${notices[0]?.text}".`, `notice text ${notices[0]?.text}`);
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 2, 'omp received exactly two new_session attempts (first try plus one retry).', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      const ipc = await ctx.conversationsIpc(s.id);
      rec.check(ipc.length === before.ids.length && JSON.stringify(currentOf(ipc)) === JSON.stringify(before.current), 'The old Conversation is still the only one and still current.', `Conversations ${JSON.stringify(idsOf(ipc))}, current ${JSON.stringify(currentOf(ipc))}`);
      rec.check(filesOf(s).length === before.files, 'No Conversation file was created.', `${filesOf(s).length} files, expected ${before.files}`);
      const page = await ctx.pageText();
      rec.check(page.includes(notices[0]?.text ?? '<no notice>'), 'The window shows the "Handoff failed" notice text.', `the window does not show "${notices[0]?.text}"`);
      await ctx.shot('plan8b-handoff-failed.png');
      // The next agent turn: what omp is sent for an ordinary follow-up must carry the notice (spec: "The agent sees the notice on its next turn").
      const promptsBefore = ctx.promptTexts(s.pid).length;
      const sent = await ctx.cdp.evaluate(`window.refract.chat.send(${JSON.stringify(s.id)}, 'What happened to the handoff?')`);
      rec.check(sent.ok, 'A follow-up message was accepted.', `chat.send: ${JSON.stringify(sent)}`);
      await ctx.sleep(1_500);
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      const next = ctx.promptTexts(s.pid).slice(promptsBefore);
      ctx.evidence('plan8b-refused-twice.json', { before, notices, conversations: ipc, promptsToOmpAfterFailure: next });
      rec.check(next.some((t) => t.includes('Handoff failed')), 'The next prompt sent to omp carries the "Handoff failed" notice.', `prompts omp received after the failure: ${JSON.stringify(next)}`);
    }
  },
  {
    name: 'plan14a-new-summary-handoff',
    title: 'plan 14: the /new summary handoff (#1212) asks for a summary, starts a fresh Conversation and sends it as the first message, unlabelled',
    async run(ctx, rec) {
      const s = await ctx.newSession('P14A');
      const before = await snapshot(ctx, s);
      const promptsBefore = ctx.promptTexts(s.pid).length;
      const res = await ctx.cdp.evaluate(`window.refract.tokenGuard.handoff(${JSON.stringify(s.id)})`);
      rec.check(res.ok && res.value.ok === true, 'tokenGuard.handoff returned ok.', `tokenGuard.handoff: ${JSON.stringify(res)}`);
      await waitConversations(ctx, s, before.ids.length + 1).catch(() => {});
      await waitForSessionStatus(ctx.cdp, s.id, 'idle');
      await ctx.sleep(500);
      const ipc = await ctx.conversationsIpc(s.id);
      const fresh = ipc.filter((c) => !before.ids.includes(c.id));
      rec.check(fresh.length === 1 && JSON.stringify(currentOf(ipc)) === JSON.stringify(idsOf(fresh)), 'Exactly one new Conversation exists and it is current.', `Conversations ${JSON.stringify(idsOf(ipc))}, before ${JSON.stringify(before.ids)}, current ${JSON.stringify(currentOf(ipc))}`);
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 1, 'omp received exactly one new_session.', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      const prompts = ctx.promptTexts(s.pid).slice(promptsBefore);
      rec.check(prompts.length === 2 && prompts[0].startsWith('Write a handoff summary'), 'omp was first asked for a summary.', `prompts ${JSON.stringify(prompts)}`);
      const first = `Continuing from a previous conversation. Handoff summary:\n\nNoted.`;
      rec.check(prompts[1] === first, 'The second prompt is the summary, wrapped as the first message of the new Conversation.', `second prompt ${JSON.stringify(prompts[1])}`);
      const newest = path.join(s.sessionDir, filesOf(s).at(-1));
      rec.check(JSON.stringify(userTextsInFile(newest)) === JSON.stringify([first]), 'The new Conversation file holds that message as its only user message.', `newest file user messages ${JSON.stringify(userTextsInFile(newest))}`);
      const users = (await ctx.transcript(s.id)).filter((t) => t.kind === 'user');
      rec.check(users.length === 1 && users[0].text === first && users[0].source?.kind !== 'handoff', 'The panes show it as one ordinary user row, not a handoff note.', `user rows ${JSON.stringify(users)}`);
      ctx.evidence('plan14a-new-summary-handoff.json', { before, result: res, conversations: ipc, prompts, newestFile: newest, transcriptUserRows: users });
      await ctx.shot('plan14a-handed-off.png');
    }
  },
  {
    name: 'plan14b-new-summary-send-failed',
    title: 'plan 14: the first message of the new Conversation is refused: handoff-send-failed wording, the new Conversation stays, no second one is started',
    async run(ctx, rec) {
      const s = await ctx.newSession('P14B');
      const before = await snapshot(ctx, s);
      ctx.setPromptRefusals(1);
      let res;
      try {
        res = await ctx.cdp.evaluate(`window.refract.tokenGuard.handoff(${JSON.stringify(s.id)})`);
        await waitForSessionStatus(ctx.cdp, s.id, 'idle');
        await ctx.sleep(500);
      } finally {
        ctx.setPromptRefusals(0);
      }
      const reason = res?.value?.reason ?? '';
      rec.check(res?.ok === true && res.value.ok === false, 'tokenGuard.handoff reported a failure, as a result and not an IPC error.', `tokenGuard.handoff: ${JSON.stringify(res)}`);
      rec.check(reason.startsWith('The new Conversation was started but the summary could not be sent: ') && reason.includes('fixture refused the first prompt after new_session'), `The failure carries the handoff-send-failed wording: "${reason}".`, `reason ${JSON.stringify(reason)}`);
      // omp started the Conversation, but its file holds no user message yet, so the list hides it (`read_conversation_file`).
      const ipc = await ctx.conversationsIpc(s.id);
      rec.check(filesOf(s).length === before.files + 1, 'omp started a new Conversation file.', `${filesOf(s).length} files, expected ${before.files + 1}`);
      const newest = path.join(s.sessionDir, filesOf(s).at(-1));
      rec.check(userTextsInFile(newest).length === 0, 'The new Conversation holds no user message: the summary was not delivered.', `newest file user messages ${JSON.stringify(userTextsInFile(newest))}`);
      rec.check(JSON.stringify(idsOf(ipc)) === JSON.stringify(before.ids) && currentOf(ipc).length === 0, 'The old Conversation is no longer current, and the message-less new one stays out of the list.', `Conversations ${JSON.stringify(idsOf(ipc))}, current ${JSON.stringify(currentOf(ipc))}`);
      rec.check(ctx.recvCount('new_session', s.pid) === before.newSessions + 1, 'No second new_session was sent after the send failed.', `new_session count ${before.newSessions} -> ${ctx.recvCount('new_session', s.pid)}`);
      ctx.evidence('plan14b-new-summary-send-failed.json', { before, result: res, conversations: ipc });
      await ctx.shot('plan14b-send-failed.png');
    }
  }
];

export default { scenarios };
