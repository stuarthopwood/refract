// #1861 cross-Session scenarios (plan.md T014 items 9, 10 and 15): who may be targeted, and when a card asks.
// One shared world per run (`world(ctx)`): P (caller, `ask`) with a child C, a sibling S, a yolo caller Y and the
// Personal Agent PA. Items 11-13 add scenarios below and reuse `world`, `withCard`, `noCard`, `settle`.

import { sleep } from './verify-tauri-cdp.mjs';
import { waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const NEW = 'refract_new_conversation';
const SWITCH = 'refract_switch_conversation';
const LIST = 'refract_list_conversations';
const CREATE = 'refract_create_session';
const SIBLING_LINE = "Outside this Session's tree";
/** Bidi controls, zero-width and line-break characters a card line must not carry. */
const UNSAFE = /[\u202A-\u202E\u2066-\u2069\u200B\u200E\u200F\u061C\uFEFF\n\r\u2028\u2029]/;

const approveCount = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`;
const approvalCards = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').map((el) => el.closest('[data-slot="card"]')).filter(Boolean)`;
const sessionRow = (id) => `document.querySelector('[data-session-open=${JSON.stringify(id)}]')`;
const headline = (s) => `${s.id.slice(0, 8)} ${s.name}`;
const worlds = new WeakMap();

/** Opens the Session's pane so a card it raises is on screen. The list is short, so the row is scrolled in first. */
export async function openSession(ctx, s) {
  const { cdp } = ctx;
  await cdp.waitFor(`!!${sessionRow(s.id)}`, { timeoutMs: 10_000, label: `row ${s.id} mounted` });
  await cdp.evaluate(`${sessionRow(s.id)}.scrollIntoView({ block: 'center' })`);
  await sleep(200);
  await cdp.click(sessionRow(s.id));
  await cdp.waitFor(`${sessionRow(s.id)}?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: `Session ${s.id} open` });
  await sleep(300);
}

/** The first card on screen: how many there are, its text on one line, and its target line as the DOM holds it. */
export const readCard = (ctx) =>
  ctx.cdp.evaluate(`(() => { const cards = ${approvalCards}; const card = cards[0]; return { count: cards.length, text: (card?.innerText ?? '').replace(/\\s+/g, ' ').trim(), target: card?.querySelector('[data-slot="card-description"]')?.textContent ?? '', body: card?.querySelector('pre, code')?.textContent ?? '' }; })()`);

/** The Session's pending requests as the runtime view carries them (`target` and `details` are what Rust sent). */
export async function pendingOf(ctx, s) {
  const r = await ctx.cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(s.id)}).then((r) => (r.ok ? r.value.runtime.pending : null))`);
  if (!r) throw new Error(`sessions.open failed for ${s.id}`);
  return r;
}

/**
 * One call from `caller` that must raise a card in its pane. `answer` is 'Approve', 'Deny' or 'close' (the request
 * answered `cancelled`, as the renderer does when a card is dismissed). `onCard(card)` sees the card before the answer.
 */
export async function withCard(ctx, caller, tool, args, answer, onCard) {
  await openSession(ctx, caller);
  const id = ctx.post(tool, args, caller.pid);
  try {
    await ctx.cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: `approval card for ${tool}` });
  } catch (err) {
    await ctx.shot(`zz-no-card-${tool}.png`).catch(() => {});
    throw err;
  }
  await sleep(300);
  const card = await readCard(ctx);
  if (onCard) await onCard(card, id);
  if (answer === 'close') {
    const pending = (await pendingOf(ctx, caller)).find((r) => r.kind === 'approval' && r.tool === tool);
    if (!pending) throw new Error(`no pending ${tool} request to close in ${caller.id}`);
    const r = await ctx.cdp.evaluate(`window.refract.chat.answer(${JSON.stringify(caller.id)}, ${JSON.stringify(pending.requestId)}, { cancelled: true })`);
    if (!r.ok) throw new Error(`chat.answer(cancelled) failed: ${JSON.stringify(r)}`);
  } else {
    await ctx.cdp.clickByText(answer);
  }
  const result = await ctx.resultFor(id);
  await sleep(300);
  return { id, card, ...result, cardsAfter: await ctx.cdp.evaluate(approveCount) };
}

/** One call that must raise no card; the caller's pane is open, so a card would be seen. */
export async function noCard(ctx, caller, tool, args) {
  await openSession(ctx, caller);
  const call = await ctx.call(tool, args, caller.pid);
  await sleep(400);
  return { ...call, cards: await ctx.cdp.evaluate(approveCount) };
}

/** Waits until the Session is idle again after a start or switch ran a turn. */
export async function settle(ctx, s) {
  await sleep(500);
  await waitForSessionStatus(ctx.cdp, s.id, 'idle', { timeoutMs: 30_000 });
}

/** What a Session holds that a refused or cancelled call must leave alone. */
export async function snapshot(ctx, s) {
  const rows = await ctx.conversationsIpc(s.id);
  return {
    ids: rows.map((c) => c.id),
    current: rows.filter((c) => c.isCurrent).map((c) => c.id),
    newSessions: ctx.recvCount('new_session', s.pid),
    switches: ctx.recvCount('switch_session', s.pid),
    prompts: ctx.promptTexts(s.pid).length
  };
}

/** Creates a child of `parent` through the Host tool (a card, approved) and returns it with its omp pid. */
async function createChild(ctx, parent, name) {
  const res = await withCard(ctx, parent, CREATE, { prompt: `Do ${name}`, name }, 'Approve');
  if (res.isError || res.body.parentId !== parent.id) throw new Error(`create ${name} under ${parent.name}: ${JSON.stringify(res.body)}`);
  const pid = await ctx.newPid();
  await waitForSessionStatus(ctx.cdp, res.body.id, 'idle', { timeoutMs: 30_000 });
  await ctx.cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.id === ${JSON.stringify(res.body.id)} && s.sessionDir && s.currentConversation))`, { timeoutMs: 30_000, label: `${name} has a Conversation` });
  const row = await ctx.row(res.body.id);
  return { id: res.body.id, name, pid, sessionDir: row.sessionDir };
}

async function personalAgent(ctx) {
  const opened = await ctx.cdp.evaluate(`window.refract.sessions.openPersonalAgent()`);
  if (!opened?.ok) throw new Error(`openPersonalAgent failed: ${JSON.stringify(opened)}`);
  const id = opened.value.id;
  // `openPersonalAgent` only registers the row; `sessions.open(id, true)` starts its omp (verify-tauri-2005).
  const started = await ctx.cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(id)}, true)`);
  if (!started?.ok) throw new Error(`sessions.open(Personal Agent, start) failed: ${JSON.stringify(started)}`);
  await ctx.cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && ['idle', 'working', 'needs-you'].includes(r.value.find((s) => s.id === ${JSON.stringify(id)})?.status))`, { timeoutMs: 60_000, label: 'Personal Agent running' });
  const pid = await ctx.newPid();
  const sent = await ctx.cdp.evaluate(`window.refract.chat.send(${JSON.stringify(id)}, 'First message of the Personal Agent')`);
  if (!sent.ok) throw new Error(`chat.send to the Personal Agent failed: ${JSON.stringify(sent)}`);
  await ctx.cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.id === ${JSON.stringify(id)} && s.sessionDir && s.currentConversation))`, { timeoutMs: 30_000, label: 'the Personal Agent has a Conversation' });
  await waitForSessionStatus(ctx.cdp, id, 'idle', { timeoutMs: 30_000 });
  const row = await ctx.row(id);
  return { id, name: row.name, pid, sessionDir: row.sessionDir };
}

/**
 * The shared Sessions: P (caller in `ask`) with child C, sibling S (a seeded older Conversation `seed-01`), Y (a
 * caller launched in `auto`, so yolo) and the Personal Agent PA. Built on first use, in the Project's `ask` mode.
 */
export function world(ctx) {
  if (!worlds.has(ctx)) worlds.set(ctx, buildWorld(ctx));
  return worlds.get(ctx);
}

async function buildWorld(ctx) {
  const P = await ctx.newSession('P');
  const C = await createChild(ctx, P, 'child-c');
  const S = await ctx.newSession('S');
  ctx.seedConversation(S.sessionDir, 'seed-01', 1);
  ctx.seedConversation(C.sessionDir, 'seed-01', 1);
  const before = await ctx.cdp.evaluate(`window.refract.settings.get().then((r) => r.value.approvalMode)`);
  const auto = await ctx.cdp.evaluate(`window.refract.settings.setApprovalMode('auto')`);
  if (!auto?.ok) throw new Error(`setApprovalMode(auto) failed: ${JSON.stringify(auto)}`);
  let Y;
  try {
    Y = await ctx.newSession('Y');
  } finally {
    await ctx.cdp.evaluate(`window.refract.settings.setApprovalMode(${JSON.stringify(before ?? 'ask')})`);
  }
  const PA = await personalAgent(ctx);
  return { P, C, S, Y, PA, modeBefore: before };
}

const startedPrompt = (ctx, s, text) => ctx.promptTexts(s.pid).some((p) => p.includes(text));

const scenarios = [
  {
    name: 'plan9-descendant-no-card',
    title: 'plan 9: descendant target (P -> its child C): no card for new or switch',
    async run(ctx, rec) {
      const { P, C } = await world(ctx);
      const before = await snapshot(ctx, C);
      const started = await noCard(ctx, P, NEW, { session_id: C.id, prompt: 'p9 descendant prompt' });
      rec.check(!started.isError && started.body.outcome === 'started' && started.body.id === C.id && started.cards === 0, 'new_conversation on descendant C returned started with no card.', `new on C: ${JSON.stringify(started)}`);
      await settle(ctx, C);
      const afterNew = await snapshot(ctx, C);
      rec.check(afterNew.newSessions === before.newSessions + 1 && startedPrompt(ctx, C, 'p9 descendant prompt'), 'C received new_session and the prompt.', `C ${JSON.stringify({ before, afterNew })}`);
      const switched = await noCard(ctx, P, SWITCH, { session_id: C.id, conversation_id: 'seed-01' });
      rec.check(!switched.isError && switched.body.outcome === 'switched' && switched.cards === 0, 'switch_conversation on descendant C returned switched with no card.', `switch on C: ${JSON.stringify(switched)}`);
      await settle(ctx, C);
      const afterSwitch = await snapshot(ctx, C);
      rec.check(afterSwitch.current.join() === 'seed-01', 'C\'s current Conversation is seed-01.', `C current ${JSON.stringify(afterSwitch.current)}`);
      ctx.evidence('plan9-descendant.json', { started, switched, before, afterNew, afterSwitch });
    }
  },
  {
    name: 'plan9-sibling-approve',
    title: 'plan 9: sibling target (P -> S): card raised, Approve runs new and switch',
    async run(ctx, rec) {
      const { P, S } = await world(ctx);
      const before = await snapshot(ctx, S);
      const startedRes = await withCard(ctx, P, NEW, { session_id: S.id, prompt: 'p9 sibling prompt' }, 'Approve', async (card) => {
        rec.check(card.count === 1 && card.text.includes(`Start a new Conversation in Session ${headline(S)}`) && card.text.includes(SIBLING_LINE), `new_conversation on sibling S raised ONE card titled "Start a new Conversation in Session ${headline(S)}" with "${SIBLING_LINE}".`, `new card (${card.count}): ${card.text.slice(0, 500)}`);
        await ctx.shot('plan9-sibling-new-card.png');
      });
      rec.check(!startedRes.isError && startedRes.body.outcome === 'started' && startedRes.body.id === S.id && startedRes.cardsAfter === 0, 'After Approve the call returned started and the card is gone.', `approve new: ${JSON.stringify(startedRes)}`);
      await settle(ctx, S);
      const afterNew = await snapshot(ctx, S);
      rec.check(afterNew.newSessions === before.newSessions + 1 && startedPrompt(ctx, S, 'p9 sibling prompt'), 'S received new_session and the prompt.', `S ${JSON.stringify({ before, afterNew })}`);
      const switchRes = await withCard(ctx, P, SWITCH, { session_id: S.id, conversation_id: 'seed-01' }, 'Approve', async (card) => {
        rec.check(card.count === 1 && card.text.includes(`Switch Conversation in Session ${headline(S)}`) && card.text.includes(SIBLING_LINE), `switch_conversation on S raised ONE card titled "Switch Conversation in Session ${headline(S)}" with "${SIBLING_LINE}".`, `switch card (${card.count}): ${card.text.slice(0, 500)}`);
        await ctx.shot('plan9-sibling-switch-card.png');
      });
      rec.check(!switchRes.isError && switchRes.body.outcome === 'switched' && switchRes.cardsAfter === 0, 'After Approve switch returned switched.', `approve switch: ${JSON.stringify(switchRes)}`);
      await settle(ctx, S);
      const afterSwitch = await snapshot(ctx, S);
      rec.check(afterSwitch.current.join() === 'seed-01', 'S\'s current Conversation is seed-01.', `S current ${JSON.stringify(afterSwitch.current)}`);
      ctx.evidence('plan9-sibling-approve.json', { before, startedRes, afterNew, switchRes, afterSwitch });
    }
  },
  {
    name: 'plan9-sibling-deny-close',
    title: 'plan 9: sibling card denied returns denied; closing it returns cancelled; nothing changes either way',
    async run(ctx, rec) {
      const { P, S } = await world(ctx);
      // Put a Conversation other than seed-01 current, so the switch has something to change.
      const rows = await ctx.conversationsIpc(S.id);
      const other = rows.find((c) => c.id !== 'seed-01' && c.id !== (rows.find((r) => r.isCurrent) ?? {}).id);
      const target = rows.find((c) => c.isCurrent)?.id === 'seed-01' ? other?.id : 'seed-01';
      rec.check(!!target, `A switch target exists (${target}).`, `no switch target in ${JSON.stringify(rows)}`);
      for (const [answer, code] of [['Deny', 'denied'], ['close', 'cancelled']]) {
        for (const [tool, args, what] of [[NEW, { session_id: S.id, prompt: `p9 ${answer} prompt` }, 'new'], [SWITCH, { session_id: S.id, conversation_id: target }, 'switch']]) {
          const before = await snapshot(ctx, S);
          const res = await withCard(ctx, P, tool, args, answer);
          await sleep(800);
          const after = await snapshot(ctx, S);
          rec.check(res.isError && ctx.code(res) === code && res.cardsAfter === 0, `${what} card ${answer === 'close' ? 'closed' : 'denied'}: the call returned ${code} and the card is gone.`, `${what} ${answer}: ${JSON.stringify(res)}`);
          rec.check(JSON.stringify(after) === JSON.stringify(before) && !startedPrompt(ctx, S, `p9 ${answer} prompt`), `${what} ${answer}: S is unchanged (Conversations, current, new_session, switch_session and prompt counts).`, `${what} ${answer}: ${JSON.stringify({ before, after })}`);
          ctx.evidence(`plan9-sibling-${answer.toLowerCase()}-${what}.json`, { res, before, after });
        }
      }
    }
  },
  {
    name: 'plan9-sibling-yolo-no-card',
    title: 'plan 9: sibling target with the caller in yolo: no card for new or switch',
    async run(ctx, rec) {
      const { Y, S } = await world(ctx);
      const rows = await ctx.conversationsIpc(S.id);
      const current = rows.find((c) => c.isCurrent)?.id;
      const target = current === 'seed-01' ? rows.find((c) => c.id !== 'seed-01')?.id : 'seed-01';
      const before = await snapshot(ctx, S);
      const started = await noCard(ctx, Y, NEW, { session_id: S.id, prompt: 'p9 yolo prompt' });
      rec.check(!started.isError && started.body.outcome === 'started' && started.cards === 0, 'In yolo, new_conversation on sibling S returned started with no card.', `yolo new: ${JSON.stringify(started)}`);
      await settle(ctx, S);
      rec.check(startedPrompt(ctx, S, 'p9 yolo prompt'), 'S received the yolo prompt.', `prompts ${JSON.stringify(ctx.promptTexts(S.pid))}`);
      const switched = await noCard(ctx, Y, SWITCH, { session_id: S.id, conversation_id: target });
      rec.check(!switched.isError && switched.body.outcome === 'switched' && switched.cards === 0, `In yolo, switch_conversation on S (to ${target}) returned switched with no card.`, `yolo switch: ${JSON.stringify(switched)}`);
      await settle(ctx, S);
      const after = await snapshot(ctx, S);
      rec.check(after.current.join() === target, `S's current Conversation is ${target}.`, `S current ${JSON.stringify(after.current)}`);
      ctx.evidence('plan9-sibling-yolo.json', { before, started, switched, after });
    }
  },
  {
    name: 'plan10-invalid-targets',
    title: 'plan 10: ancestor and Personal Agent from another Session are invalid_target; the Personal Agent may target itself',
    async run(ctx, rec) {
      const { P, C, PA } = await world(ctx);
      const attempts = [
        ['ancestor P from child C', C, P],
        ['the Personal Agent from P', P, PA]
      ];
      for (const [what, caller, target] of attempts) {
        const before = await snapshot(ctx, target);
        for (const [tool, args] of [[LIST, { session_id: target.id }], [NEW, { session_id: target.id, prompt: 'p10 refused' }], [SWITCH, { session_id: target.id, conversation_id: 'seed-01' }]]) {
          const res = await noCard(ctx, caller, tool, args);
          rec.check(res.isError && ctx.code(res) === 'invalid_target' && res.cards === 0, `${tool} on ${what} returned invalid_target with no card.`, `${tool} ${what}: ${JSON.stringify(res)}`);
        }
        const after = await snapshot(ctx, target);
        rec.check(JSON.stringify(after) === JSON.stringify(before), `${what}: the target is unchanged.`, `${what}: ${JSON.stringify({ before, after })}`);
      }
      const listed = await noCard(ctx, PA, LIST, { session_id: PA.id });
      rec.check(!listed.isError && Array.isArray(listed.body.conversations) && listed.body.conversations.length >= 1, 'The Personal Agent listed its own Conversations.', `PA list: ${JSON.stringify(listed)}`);
      const started = await noCard(ctx, PA, NEW, { session_id: PA.id, prompt: 'p10 personal self prompt' });
      rec.check(!started.isError && started.body.outcome === 'started' && started.body.id === PA.id && started.cards === 0, 'The Personal Agent started a new Conversation on itself with no card.', `PA new: ${JSON.stringify(started)}`);
      await settle(ctx, PA);
      rec.check(startedPrompt(ctx, PA, 'p10 personal self prompt'), 'The Personal Agent received its own prompt.', `PA prompts ${JSON.stringify(ctx.promptTexts(PA.pid))}`);
      ctx.evidence('plan10-invalid-targets.json', { listed, started });
    }
  },
  {
    name: 'plan15-card-line-flattened',
    title: 'plan 15: a Session name with a bidi control or a newline, and a prompt with a newline, are flattened on the card',
    async run(ctx, rec) {
      const { P, S } = await world(ctx);
      const original = S.name;
      const hostile = 'Alpha\u202Egnirts\u202C\nBeta\u2066Gamma\u2069';
      const renamed = await ctx.cdp.evaluate(`window.refract.sessions.rename(${JSON.stringify(S.id)}, ${JSON.stringify(hostile)})`);
      rec.check(renamed?.ok === true, 'The Session was renamed to a name with a bidi control and a newline.', `rename: ${JSON.stringify(renamed)}`);
      const row = await ctx.row(S.id);
      ctx.evidence('plan15-renamed-row.json', { stored: row?.name, hostile });
      try {
        const res = await withCard(ctx, P, NEW, { session_id: S.id, prompt: 'Prompt first line\nPrompt second\u202E line' }, 'Deny', async (card) => {
          const pending = (await pendingOf(ctx, P)).find((r) => r.kind === 'approval' && r.tool === NEW);
          rec.check(!!pending, 'The pending request is in the runtime view.', `pending: ${JSON.stringify(await pendingOf(ctx, P))}`);
          const lines = [pending?.target ?? '', ...(pending?.details ?? [])];
          rec.check(lines.every((l) => !UNSAFE.test(l)), 'No card line Rust sent (title and details) holds a bidi control, zero-width character or line break.', `unsafe in ${JSON.stringify(lines)}`);
          // The detail block is one DOM line per Rust detail line, so `\n` separates lines; each line must hold no break itself.
          const domBody = String(card.body ?? '').split('\n');
          rec.check(!UNSAFE.test(card.target) && domBody.every((l) => !UNSAFE.test(l)) && domBody.length === (pending?.details ?? []).length, 'The card the window renders carries none either (title line, and one DOM line per detail line).', `DOM target ${JSON.stringify(card.target)} body ${JSON.stringify(card.body)} details ${JSON.stringify(pending?.details)}`);
          rec.check(pending?.target.includes('Alpha') && pending.target.includes('Beta') && /Alpha\S* *\S*Beta|Alpha.*Beta/.test(pending.target), 'Both halves of the name survive, joined on one line.', `target ${JSON.stringify(pending?.target)}`);
          rec.check((pending?.details ?? []).some((l) => l.includes('Prompt first line') && l.includes('Prompt second')), 'The prompt line is one line holding both halves.', `details ${JSON.stringify(pending?.details)}`);
          ctx.evidence('plan15-card.json', { pending, dom: card });
          await ctx.shot('plan15-flattened-card.png');
        });
        rec.check(res.isError && ctx.code(res) === 'denied', 'The card was denied.', `deny: ${JSON.stringify(res)}`);
      } finally {
        await ctx.cdp.evaluate(`window.refract.sessions.rename(${JSON.stringify(S.id)}, ${JSON.stringify(original)})`);
      }
    }
  }
];

export default { scenarios };
