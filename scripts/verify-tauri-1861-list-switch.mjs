// #1861 user story 2 (spec.md): list and switch Conversations. Session A holds 25 Conversations (its own, the newest,
// plus `seed-01`..`seed-24`); Session B is a second Session of the same Project with a Conversation of its own.

const LIST = 'refract_list_conversations';
const SWITCH = 'refract_switch_conversation';
const TARGET = 'seed-10';

const currentOf = (rows) => rows.filter((c) => c.isCurrent).map((c) => c.id);
const newestFirst = (rows) => rows.every((c, i) => i === 0 || rows[i - 1].createdAt >= c.createdAt);

/** Puts `conversationId` current through the tool when it is not already, so a scenario run alone has its precondition. */
async function ensureCurrent(ctx, a, conversationId) {
  const listed = await ctx.call(LIST, { session_id: a.id, limit: 100 }, a.pid);
  if (currentOf(listed.body.conversations)[0] === conversationId) return;
  const moved = await ctx.call(SWITCH, { session_id: a.id, conversation_id: conversationId }, a.pid);
  if (moved.isError || moved.body.outcome !== 'switched') throw new Error(`precondition switch failed: ${JSON.stringify(moved)}`);
}

async function waitCurrentIs(ctx, a, conversationId) {
  await ctx.cdp.waitFor(
    `window.refract.conversations.list(${JSON.stringify(a.id)}).then((r) => r.ok && r.value.filter((c) => c.isCurrent).map((c) => c.id).join() === ${JSON.stringify(conversationId)})`,
    { timeoutMs: 15_000, label: `${conversationId} is the only current Conversation` }
  );
}

const scenarios = [
  {
    name: 'list-limit',
    title: '25 Conversations: no limit returns the 20 newest, newest first, exactly one current',
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      const all = await ctx.conversationsIpc(a.id);
      rec.check(all.length === 25, 'The renderer IPC lists all 25 Conversations of Session A (1 own + 24 seeded).', `IPC lists ${all.length} Conversations, expected 25`);
      const res = await ctx.call(LIST, { session_id: a.id }, a.pid);
      ctx.evidence('scenario-1-list-limit.json', { call: { tool: LIST, args: res.args }, result: res.body, ipcIds: all.map((c) => c.id) });
      rec.check(!res.isError, 'list_conversations with no limit succeeded.', `list errored: ${JSON.stringify(res.body)}`);
      const rows = res.body.conversations ?? [];
      rec.check(rows.length === 20, 'No limit returned exactly 20 of the 25 Conversations (default limit).', `returned ${rows.length} rows, expected 20`);
      rec.check(newestFirst(rows), 'The rows are newest first.', `rows not newest first: ${JSON.stringify(rows.map((c) => c.createdAt))}`);
      const expected = all.slice(0, 20).map((c) => c.id);
      rec.check(JSON.stringify(rows.map((c) => c.id)) === JSON.stringify(expected), 'The 20 rows are the 20 newest, in the same order as the IPC list.', `ids ${JSON.stringify(rows.map((c) => c.id))} differ from newest 20 ${JSON.stringify(expected)}`);
      rec.check(currentOf(rows).length === 1, 'Exactly one row is isCurrent.', `isCurrent rows: ${JSON.stringify(currentOf(rows))}`);
      rec.check(res.body.session_id === a.id, 'The result names Session A.', `session_id ${res.body.session_id}`);
    }
  },
  {
    name: 'switch-owned',
    title: 'Switching to an owned Conversation makes it the current one',
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      const before = ctx.recvCount('switch_session', a.pid);
      const res = await ctx.call(SWITCH, { session_id: a.id, conversation_id: TARGET }, a.pid);
      ctx.evidence('scenario-2-switch-owned.json', { call: { tool: SWITCH, args: res.args }, result: res.body });
      rec.check(!res.isError && res.body.outcome === 'switched', 'switch_conversation to an owned id returned outcome "switched".', `switch result: ${JSON.stringify(res.body)}`);
      await waitCurrentIs(ctx, a, TARGET).catch(() => {});
      const ipc = await ctx.conversationsIpc(a.id);
      rec.check(JSON.stringify(currentOf(ipc)) === JSON.stringify([TARGET]), `The renderer IPC list now marks only ${TARGET} current.`, `IPC current ids: ${JSON.stringify(currentOf(ipc))}`);
      const listed = await ctx.call(LIST, { session_id: a.id, limit: 100 }, a.pid);
      rec.check(JSON.stringify(currentOf(listed.body.conversations ?? [])) === JSON.stringify([TARGET]), `list_conversations afterwards marks only ${TARGET} current.`, `tool current ids: ${JSON.stringify(currentOf(listed.body.conversations ?? []))}`);
      const row = await ctx.row(a.id);
      rec.check(String(row?.currentConversation ?? '').endsWith(`_${TARGET}.jsonl`), 'The Session row records the chosen file as its current Conversation.', `currentConversation ${row?.currentConversation}`);
      rec.check(ctx.recvCount('switch_session', a.pid) === before + 1, 'omp received exactly one switch_session for the call.', `switch_session count ${before} -> ${ctx.recvCount('switch_session', a.pid)}`);
      await ctx.shot('scenario-2-after-switch.png');
    }
  },
  {
    name: 'switch-current',
    title: 'Switching to the current Conversation returns unchanged',
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      await ensureCurrent(ctx, a, TARGET);
      const before = ctx.recvCount('switch_session', a.pid);
      const res = await ctx.call(SWITCH, { session_id: a.id, conversation_id: TARGET }, a.pid);
      ctx.evidence('scenario-3-switch-current.json', { call: { tool: SWITCH, args: res.args }, result: res.body });
      rec.check(!res.isError && res.body.outcome === 'unchanged', 'switch_conversation to the current id returned outcome "unchanged".', `result: ${JSON.stringify(res.body)}`);
      rec.check(res.body.conversation_id === TARGET && res.body.id === a.id, 'The result echoes the Session and Conversation ids.', `result: ${JSON.stringify(res.body)}`);
      await ctx.sleep(400);
      rec.check(ctx.recvCount('switch_session', a.pid) === before, 'omp received no switch_session: nothing was reloaded.', `switch_session count ${before} -> ${ctx.recvCount('switch_session', a.pid)}`);
    }
  },
  {
    name: 'switch-foreign',
    title: 'An id from another Session returns not_found and changes nothing',
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      const b = await ctx.sessionB();
      await ensureCurrent(ctx, a, TARGET);
      const before = ctx.recvCount('switch_session');
      const res = await ctx.call(SWITCH, { session_id: a.id, conversation_id: b.conversationId }, a.pid);
      ctx.evidence('scenario-4-switch-foreign.json', { sessionB: { id: b.id, conversationId: b.conversationId }, call: { tool: SWITCH, args: res.args }, result: res.body });
      rec.check(res.isError && ctx.code(res) === 'not_found', "switch_conversation to Session B's Conversation id returned not_found.", `result: ${JSON.stringify(res)}`);
      const ipc = await ctx.conversationsIpc(a.id);
      rec.check(!ipc.some((c) => c.id === b.conversationId), "Session B's Conversation is not among Session A's Conversations.", `A lists ${b.conversationId}`);
      rec.check(JSON.stringify(currentOf(ipc)) === JSON.stringify([TARGET]), `Session A's current Conversation is still ${TARGET}.`, `current ids: ${JSON.stringify(currentOf(ipc))}`);
      await ctx.sleep(400);
      rec.check(ctx.recvCount('switch_session') === before, 'No omp process received a switch_session.', `switch_session count ${before} -> ${ctx.recvCount('switch_session')}`);
    }
  },
  {
    name: 'plan1-limit-bounds',
    title: 'plan 1 (rest): limit 100 returns all 25 Conversations; limit 101 is invalid_input',
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      const all = await ctx.conversationsIpc(a.id);
      const max = await ctx.call(LIST, { session_id: a.id, limit: 100 }, a.pid);
      const rows = max.body.conversations ?? [];
      rec.check(!max.isError && rows.length === 25, 'limit 100 returned all 25 Conversations.', `limit 100: isError ${max.isError}, ${rows.length} rows, expected 25`);
      rec.check(JSON.stringify(rows.map((c) => c.id)) === JSON.stringify(all.map((c) => c.id)), 'The 25 rows match the IPC list, newest first.', `ids ${JSON.stringify(rows.map((c) => c.id))} differ from IPC ${JSON.stringify(all.map((c) => c.id))}`);
      const over = await ctx.call(LIST, { session_id: a.id, limit: 101 }, a.pid);
      ctx.evidence('plan1-limit-bounds.json', { limit100: { args: max.args, rowCount: rows.length }, limit101: { args: over.args, result: over.body } });
      rec.check(over.isError && ctx.code(over) === 'invalid_input', 'limit 101 returned the error code invalid_input.', `limit 101 result: ${JSON.stringify(over)}`);
    }
  },
  {
    name: 'plan2-list-project-scope',
    title: "plan 2: listing another Project's Session is not_found; listing a Session of the same Project works with no approval card",
    async run(ctx, rec) {
      const a = await ctx.sessionA();
      const b = await ctx.sessionB();
      const other = await ctx.otherProjectSession();
      const foreign = await ctx.call(LIST, { session_id: other.id }, a.pid);
      ctx.evidence('plan2-other-project.json', { caller: a.id, target: other.id, call: { tool: LIST, args: foreign.args }, result: foreign.body });
      rec.check(foreign.isError && ctx.code(foreign) === 'not_found', "list_conversations on another Project's Session returned not_found.", `result: ${JSON.stringify(foreign)}`);
      rec.check(foreign.body.conversations === undefined, "The refusal reveals none of that Session's Conversations.", `body: ${JSON.stringify(foreign.body)}`);
      const sibling = await ctx.call(LIST, { session_id: b.id }, a.pid);
      const siblingIpc = await ctx.conversationsIpc(b.id);
      ctx.evidence('plan2-same-project.json', { caller: a.id, target: b.id, call: { tool: LIST, args: sibling.args }, result: sibling.body, ipcIds: siblingIpc.map((c) => c.id) });
      rec.check(!sibling.isError && JSON.stringify((sibling.body.conversations ?? []).map((c) => c.id)) === JSON.stringify(siblingIpc.map((c) => c.id)), "list_conversations on a same-Project Session returned that Session's Conversations.", `result: ${JSON.stringify(sibling)}`);
      const requests = [...(await ctx.transcript(a.id)), ...(await ctx.transcript(b.id))].filter((t) => t.kind === 'request');
      rec.check(requests.length === 0, 'No approval card (request row) appeared in either Session.', `request rows: ${JSON.stringify(requests)}`);
      await ctx.shot('plan2-after-list.png');
    }
  },
  {
    name: 'plan7-self-switch-mid-turn',
    title: 'plan 7 (rest): switch_conversation on itself mid-turn returns scheduled; the switch happens only after the turn settles',
    async run(ctx, rec) {
      const s = await ctx.newSession('P7');
      const target = 'seed-p7';
      ctx.seedConversation(s.sessionDir, target, 1);
      await ctx.holdTurn(s);
      const before = ctx.recvCount('switch_session', s.pid);
      const res = await ctx.call(SWITCH, { session_id: s.id, conversation_id: target }, s.pid);
      ctx.evidence('plan7-scheduled.json', { call: { tool: SWITCH, args: res.args }, result: res.body });
      rec.check(!res.isError && res.body.outcome === 'scheduled', 'switch_conversation mid-turn returned outcome "scheduled".', `result: ${JSON.stringify(res)}`);
      await ctx.sleep(1_000);
      const queued = await ctx.conversationsIpc(s.id);
      rec.check(!currentOf(queued).includes(target) && ctx.recvCount('switch_session', s.pid) === before, 'While the turn runs nothing switched: the target is not current and omp got no switch_session.', `current ${JSON.stringify(currentOf(queued))}, switch_session ${before} -> ${ctx.recvCount('switch_session', s.pid)}`);
      ctx.settleTurn(s.pid);
      await waitCurrentIs(ctx, s, target).catch(() => {});
      const ipc = await ctx.conversationsIpc(s.id);
      rec.check(JSON.stringify(currentOf(ipc)) === JSON.stringify([target]), `After the turn settled, ${target} is the only current Conversation.`, `current ids ${JSON.stringify(currentOf(ipc))}`);
      rec.check(ctx.recvCount('switch_session', s.pid) === before + 1, 'omp received exactly one switch_session.', `switch_session count ${before} -> ${ctx.recvCount('switch_session', s.pid)}`);
      const row = await ctx.row(s.id);
      rec.check(String(row?.currentConversation ?? '').endsWith(`_${target}.jsonl`), 'The Session row records the target file as its current Conversation.', `currentConversation ${row?.currentConversation}`);
      await ctx.shot('plan7-after-settle.png');
    }
  }
];

export default { scenarios };
