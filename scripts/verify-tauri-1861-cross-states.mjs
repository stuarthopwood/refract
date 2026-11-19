// #1861 cross-Session target states (plan.md T014 items 11, 12 and 13): what a sibling target's state does to
// `refract_new_conversation` and `refract_switch_conversation`. Every scenario gets Sessions of its own, so a state one
// leaves behind (paused, archived, deleted) never reaches another. They reuse the shared world of the `cross` group
// for the caller P; the targets are siblings of P, so every action that proceeds raises a card.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { waitForSessionStatus } from './verify-tauri-560-helpers.mjs';
import { world, withCard, noCard, settle, snapshot, openSession } from './verify-tauri-1861-cross.mjs';

const NEW = 'refract_new_conversation';
const SWITCH = 'refract_switch_conversation';

/** A sibling of P (same Project, outside its tree) holding the older Conversation `seed-01` to switch to. */
async function sibling(ctx, label) {
  const s = await ctx.newSession(label);
  ctx.seedConversation(s.sessionDir, 'seed-01', 1);
  return s;
}

/** The text of every prompt omp `pid` got that is one Session message from `from`, with `body` inside. */
const envelopes = (ctx, pid, from, body) =>
  ctx.promptTexts(pid).filter((t) => t.startsWith('<session-message from="') && t.includes(`session="${from.id}"`) && t.includes(body) && t.endsWith('</session-message>'));

const call = (_ctx, _P, s, tool, tag) =>
  tool === NEW ? [tool, { session_id: s.id, prompt: `${tag} prompt` }] : [tool, { session_id: s.id, conversation_id: 'seed-01' }];

/** Nothing a refused or dropped action could change moved: Conversations, current, omp commands and prompts. */
async function assertUntouched(ctx, rec, s, before, what) {
  const after = await snapshot(ctx, s);
  rec.check(JSON.stringify(after) === JSON.stringify(before), `${what}: ${s.name} is unchanged (Conversations, current, new_session, switch_session and prompt counts).`, `${what}: ${JSON.stringify({ before, after })}`);
}

/** Archives a finished target: the sidebar mounts only a handful of rows per Project, so spent siblings must leave it before the next quick-create. */
async function retire(ctx, s) {
  const r = await ctx.cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(s.id)})`);
  if (!r?.ok) throw new Error(`retire ${s.name}: ${JSON.stringify(r)}`);
}

const refused = (res, state) => res.isError && res.body?.error?.code === 'invalid_state' && (!state || String(res.body.error.message).toLowerCase().includes(state));

/** Writes `count` small untracked files into the Session's worktree, so its background removal takes a while. */
function bloat(worktreePath, count) {
  const per = 100;
  for (let d = 0; d < count / per; d++) {
    const dir = path.join(worktreePath, 'bulk', `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < per; f++) writeFileSync(path.join(dir, `f${f}.txt`), `${d}-${f}`);
  }
}

const scenarios = [
  {
    name: 'plan11-paused-archived-targets',
    title: 'plan 11: a paused and an archived sibling are invalid_state for new and switch: no card, nothing changed',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      const T = await sibling(ctx, 'T11a');
      const paused = await ctx.cdp.evaluate(`window.refract.chat.pause(${JSON.stringify(T.id)})`);
      rec.check(paused?.ok === true && (await ctx.row(T.id))?.pause === 'paused', 'The sibling is paused (row pause "paused").', `pause: ${JSON.stringify(paused)} row ${JSON.stringify(await ctx.row(T.id))}`);
      const before = await snapshot(ctx, T);
      const out = {};
      for (const tool of [NEW, SWITCH]) {
        const res = await noCard(ctx, P, ...call(ctx, P, T, tool, 'p11 paused'));
        out[`paused-${tool}`] = res;
        rec.check(refused(res, 'paused') && res.cards === 0, `${tool} on the paused sibling returned invalid_state ("paused") with no card.`, `${tool} paused: ${JSON.stringify(res)}`);
      }
      await assertUntouched(ctx, rec, T, before, 'paused');
      const resumed = await ctx.cdp.evaluate(`window.refract.chat.resume(${JSON.stringify(T.id)})`);
      rec.check(resumed?.ok === true, 'The sibling was resumed.', `resume: ${JSON.stringify(resumed)}`);

      const archived = await ctx.cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(T.id)})`);
      const row = await ctx.row(T.id);
      rec.check(archived?.ok === true && row?.archivedAt, 'The sibling is archived (row archivedAt set).', `archive: ${JSON.stringify(archived)} row ${JSON.stringify(row)}`);
      const beforeArchived = await snapshot(ctx, T);
      for (const tool of [NEW, SWITCH]) {
        const res = await noCard(ctx, P, ...call(ctx, P, T, tool, 'p11 archived'));
        out[`archived-${tool}`] = res;
        rec.check(refused(res, 'archived') && res.cards === 0, `${tool} on the archived sibling returned invalid_state ("archived") with no card.`, `${tool} archived: ${JSON.stringify(res)}`);
      }
      await assertUntouched(ctx, rec, T, beforeArchived, 'archived');
      ctx.evidence('plan11-paused-archived.json', { results: out, before, beforeArchived });
      await ctx.shot('plan11-archived-refused.png');
    }
  },
  {
    name: 'plan11-deleting-target',
    title: 'plan 11: a sibling whose background removal is running is invalid_state for new and switch',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      await openSession(ctx, P);
      // The removal runs in the background and the window is short, so a bigger worktree is retried until a call lands inside it.
      for (const files of [3000, 9000, 20000]) {
        const T = await sibling(ctx, `T11d${files}`);
        const row = await ctx.row(T.id);
        bloat(row.worktreePath, files);
        const before = await snapshot(ctx, T);
        // Nothing awaits between the delete and the two calls: they must reach the handler while the removal still runs.
        const deleted = await ctx.cdp.evaluate(`window.refract.sessions.delete(${JSON.stringify(T.id)}, { confirmed: true })`);
        if (deleted?.ok !== true) throw new Error(`sessions.delete failed: ${JSON.stringify(deleted)}`);
        const ids = [NEW, SWITCH].map((tool) => ctx.post(tool, call(ctx, P, T, tool, 'p11 deleting')[1], P.pid));
        const results = [];
        for (const id of ids) results.push(await ctx.resultFor(id));
        const stillDeleting = await ctx.cdp.evaluate(`window.refract.sessions.deleting().then((r) => r.ok && r.value.includes(${JSON.stringify(T.id)}))`);
        ctx.evidence(`plan11-deleting-${files}.json`, { files, stillDeletingAfterResults: stillDeleting, results });
        if (!results.every((r) => r.isError && r.body?.error?.code === 'invalid_state')) {
          rec.check(results.every((r) => r.isError && r.body?.error?.code === 'not_found'), `With ${files} files the removal finished before the calls arrived (not_found); retrying with more.`, `results ${JSON.stringify(results)}`);
          continue;
        }
        results.forEach((r, i) => rec.check(String(r.body.error.message).toLowerCase().includes('deleted') && String(r.body.error.message).includes('being'), `${[NEW, SWITCH][i]} on the deleting sibling returned invalid_state ("being deleted").`, `${[NEW, SWITCH][i]}: ${JSON.stringify(r)}`));
        rec.check((await ctx.cdp.evaluate(`Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`)) === 0, 'Neither call raised a card.', 'a card is on screen');
        await ctx.cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && !r.value.some((s) => s.id === ${JSON.stringify(T.id)}))`, { timeoutMs: 120_000, label: 'removal finished' });
        const gone = await noCard(ctx, P, ...call(ctx, P, T, NEW, 'p11 gone'));
        rec.check(gone.isError && ctx.code(gone) === 'not_found', 'Once the removal finished the same call returns not_found, so the earlier invalid_state really was the deleting state.', `after removal: ${JSON.stringify(gone)}`);
        rec.check(ctx.recvCount('new_session', T.pid) === before.newSessions && ctx.promptTexts(T.pid).length === before.prompts, 'The deleting target received no new_session and no prompt.', `${JSON.stringify(before)} new_session ${ctx.recvCount('new_session', T.pid)}`);
        ctx.evidence('plan11-deleting.json', { files, results, gone, before });
        return;
      }
      rec.check(false, 'A call landed inside the removal window.', 'all attempts (3000, 9000, 20000 files) returned not_found: the removal always finished first');
    }
  },
  {
    name: 'plan11-stopped-target',
    title: 'plan 11: a Stopped sibling is launched on the new or chosen Conversation (card approved), for both tools',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      const T = await sibling(ctx, 'T11s');
      const stopSibling = async () => {
        const stopped = await ctx.cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(T.id)})`);
        if (!stopped?.ok) throw new Error(`stopAgent failed: ${JSON.stringify(stopped)}`);
        await waitForSessionStatus(ctx.cdp, T.id, 'stopped', { timeoutMs: 30_000 });
      };
      await stopSibling();
      const before = await snapshot(ctx, T);
      const started = await withCard(ctx, P, NEW, { session_id: T.id, prompt: 'p11 stopped new prompt' }, 'Approve', async (card) => {
        rec.check(card.count === 1 && card.text.includes('Start a new Conversation in Session'), 'A Stopped sibling still raises the card for new_conversation.', `card: ${card.text.slice(0, 400)}`);
        await ctx.shot('plan11-stopped-new-card.png');
      });
      rec.check(!started.isError && started.body.outcome === 'started' && started.body.id === T.id, 'After Approve new_conversation on the Stopped sibling returned started.', `new: ${JSON.stringify(started)}`);
      const pid2 = await ctx.newPid();
      await settle(ctx, T);
      const afterNew = await snapshot(ctx, T);
      rec.check(envelopes(ctx, pid2, P, 'p11 stopped new prompt').length === 1, 'The relaunched omp received the prompt in the sender envelope.', `prompts of the new process ${JSON.stringify(ctx.promptTexts(pid2))}`);
      const rowNew = await ctx.row(T.id);
      rec.check(rowNew?.status === 'idle' && afterNew.ids.length === before.ids.length + 1 && afterNew.current.length === 1 && !before.current.includes(afterNew.current[0]), 'The sibling is running again on one new Conversation that is current.', `row ${rowNew?.status}; ${JSON.stringify({ before, afterNew })}`);
      ctx.evidence('plan11-stopped-new.json', { before, started, pid2, afterNew, prompts: ctx.promptTexts(pid2) });

      await stopSibling();
      const switched = await withCard(ctx, P, SWITCH, { session_id: T.id, conversation_id: 'seed-01' }, 'Approve', async (card) => {
        rec.check(card.count === 1 && card.text.includes('Switch Conversation in Session'), 'A Stopped sibling still raises the card for switch_conversation.', `card: ${card.text.slice(0, 400)}`);
        await ctx.shot('plan11-stopped-switch-card.png');
      });
      rec.check(!switched.isError && switched.body.outcome === 'switched' && switched.body.id === T.id, 'After Approve switch_conversation on the Stopped sibling returned switched.', `switch: ${JSON.stringify(switched)}`);
      const pid3 = await ctx.newPid();
      await settle(ctx, T);
      const afterSwitch = await snapshot(ctx, T);
      rec.check((await ctx.row(T.id))?.status === 'idle' && afterSwitch.current.join() === 'seed-01', 'The sibling is running again and seed-01 is its current Conversation.', `current ${JSON.stringify(afterSwitch.current)}; row ${(await ctx.row(T.id))?.status}`);
      ctx.evidence('plan11-stopped-switch.json', { switched, pid3, afterSwitch, recv: { new_session: ctx.recvCount('new_session', pid3), switch_session: ctx.recvCount('switch_session', pid3) } });
      await ctx.shot('plan11-stopped-relaunched.png');
      await retire(ctx, T);
    }
  },
  {
    name: 'plan12-mid-turn-sibling-runs-on-settle',
    title: 'plan 12: sibling mid-turn, card approved: scheduled; the action runs when that turn settles, with the envelope on the prompt',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      for (const tool of [NEW, SWITCH]) {
        const T = await sibling(ctx, `T12-${tool === NEW ? 'new' : 'switch'}`);
        await ctx.holdTurn(T);
        const before = await snapshot(ctx, T);
        const [, args] = call(ctx, P, T, tool, 'p12 sibling');
        const res = await withCard(ctx, P, tool, args, 'Approve');
        rec.check(!res.isError && res.body.outcome === 'scheduled' && res.body.id === T.id, `${tool} on a mid-turn sibling, card approved: returned scheduled.`, `${tool}: ${JSON.stringify(res)}`);
        await sleep(1_500);
        await assertUntouched(ctx, rec, T, before, `${tool} while queued`);
        rec.check((await ctx.row(T.id))?.status === 'working', 'The sibling\'s turn is still running while the action waits.', `status ${(await ctx.row(T.id))?.status}`);
        ctx.settleTurn(T.pid);
        await ctx.cdp.waitFor(`window.refract.conversations.list(${JSON.stringify(T.id)}).then((r) => r.ok && ${tool === NEW ? `r.value.length === ${before.ids.length + 1}` : `r.value.some((c) => c.isCurrent && c.id === 'seed-01')`})`, { timeoutMs: 20_000, label: `${tool} ran on settle` }).catch(() => {});
        await settle(ctx, T);
        const after = await snapshot(ctx, T);
        if (tool === NEW) {
          const wrapped = envelopes(ctx, T.pid, P, 'p12 sibling prompt');
          rec.check(after.newSessions === before.newSessions + 1 && after.ids.length === before.ids.length + 1 && wrapped.length === 1, 'On settle one new Conversation started and the prompt reaching the target\'s omp is wrapped in the sender envelope.', `${JSON.stringify({ before, after })} prompts ${JSON.stringify(ctx.promptTexts(T.pid))}`);
          ctx.evidence('plan12-new-runs-on-settle.json', { before, res, after, envelopePrompts: wrapped, prompts: ctx.promptTexts(T.pid) });
        } else {
          rec.check(after.switches === before.switches + 1 && after.current.join() === 'seed-01', 'On settle the target switched to seed-01.', `${JSON.stringify({ before, after })}`);
          ctx.evidence('plan12-switch-runs-on-settle.json', { before, res, after });
        }
        await ctx.shot(`plan12-${tool === NEW ? 'new' : 'switch'}-after-settle.png`);
        await retire(ctx, T);
      }
    }
  },
  {
    name: 'plan12-mid-turn-sibling-stop-drops',
    title: 'plan 12: the sibling\'s turn stopped instead of settling: the scheduled action is dropped (new and switch)',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      const T = await sibling(ctx, 'T12-stop');
      for (const tool of [NEW, SWITCH]) {
        await ctx.holdTurn(T);
        const before = await snapshot(ctx, T);
        const [, args] = call(ctx, P, T, tool, 'p12 dropped');
        const res = await withCard(ctx, P, tool, args, 'Approve');
        rec.check(!res.isError && res.body.outcome === 'scheduled', `${tool}: scheduled on the mid-turn sibling.`, `${tool}: ${JSON.stringify(res)}`);
        const stopped = await ctx.cdp.evaluate(`window.refract.chat.stop(${JSON.stringify(T.id)})`);
        rec.check(stopped?.ok === true, 'chat.stop on the sibling succeeded.', `chat.stop: ${JSON.stringify(stopped)}`);
        await waitForSessionStatus(ctx.cdp, T.id, 'idle');
        await sleep(1_500);
        await assertUntouched(ctx, rec, T, before, `${tool} after the stop`);
        // A later turn that settles must not release a stale slot.
        const sent = await ctx.cdp.evaluate(`window.refract.chat.send(${JSON.stringify(T.id)}, 'A plain follow-up')`);
        rec.check(sent?.ok === true, 'A follow-up message was accepted.', `chat.send: ${JSON.stringify(sent)}`);
        await sleep(1_500);
        await waitForSessionStatus(ctx.cdp, T.id, 'idle');
        const later = await snapshot(ctx, T);
        rec.check(later.newSessions === before.newSessions && later.switches === before.switches && later.current.join() === before.current.join() && envelopes(ctx, T.pid, P, 'p12 dropped').length === 0, `${tool}: after a later turn settled nothing from the dropped action ran.`, `${JSON.stringify({ before, later })}`);
        ctx.evidence(`plan12-${tool === NEW ? 'new' : 'switch'}-dropped.json`, { before, res, later });
      }
      const page = await ctx.pageText();
      rec.check(!page.includes('Handoff failed'), 'No "Handoff failed" notice appeared.', 'the window shows a Handoff failed notice');
      await ctx.shot('plan12-after-stop.png');
      await retire(ctx, T);
    }
  },
  {
    name: 'plan13-archived-while-card-open',
    title: 'plan 13: target archived while the card is open, then Approve: invalid_state and nothing changed (new and switch)',
    async run(ctx, rec) {
      const { P } = await world(ctx);
      for (const tool of [NEW, SWITCH]) {
        const T = await sibling(ctx, `T13-${tool === NEW ? 'new' : 'switch'}`);
        const before = await snapshot(ctx, T);
        const [, args] = call(ctx, P, T, tool, 'p13 archived');
        const res = await withCard(ctx, P, tool, args, 'Approve', async (card) => {
          rec.check(card.count === 1, `${tool}: the card is open.`, `card: ${card.text.slice(0, 300)}`);
          const archived = await ctx.cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(T.id)})`);
          rec.check(archived?.ok === true, `${tool}: the target was archived while the card is open.`, `archive: ${JSON.stringify(archived)}`);
          await ctx.shot(`plan13-${tool === NEW ? 'new' : 'switch'}-card-target-archived.png`);
        });
        rec.check(refused(res, 'archived') && res.cardsAfter === 0, `${tool}: Approve returned invalid_state ("archived") and the card is gone.`, `${tool}: ${JSON.stringify(res)}`);
        await sleep(800);
        await assertUntouched(ctx, rec, T, before, `${tool} after Approve`);
        rec.check(!!(await ctx.row(T.id))?.archivedAt, `${tool}: the target is still archived (the call did not restore or launch it).`, `row ${JSON.stringify(await ctx.row(T.id))}`);
        ctx.evidence(`plan13-${tool === NEW ? 'new' : 'switch'}-archived.json`, { before, res });
      }
    }
  }
];

export default { scenarios };
