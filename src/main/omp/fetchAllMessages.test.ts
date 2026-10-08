// Issue #510 slice 4 (PLAN.md row A0): regression coverage for fetchAllMessages's pagination
// and its "never throws, complete only when every page genuinely succeeded" contract.
import { describe, it, expect } from 'vitest';
import { fetchAllMessages, MESSAGES_PAGE_SIZE } from './fetchAllMessages';
import type { MessagesPageRequester } from './fetchAllMessages';
import type { OmpMessage, ResponseFrame } from '../../shared/frames';

function userMessage(text: string): OmpMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** A fake requester backed by a fixed, in-memory message array, paginating it exactly the way
 * the real server was observed to (docs/spike/FINDINGS.md item 47): `limit` honoured, `offset`
 * ignored, `cursor` a plain opaque string this fake itself issues and expects back verbatim. */
function fakeServer(messages: OmpMessage[]): MessagesPageRequester {
  return {
    async request(cmd): Promise<ResponseFrame> {
      if (cmd.type === 'get_messages') {
        return { type: 'response', id: cmd.id, command: 'get_messages', success: true, data: { messages } };
      }
      if (cmd.type !== 'get_messages_page') throw new Error(`unexpected command ${cmd.type}`);
      const start = cmd.cursor ? Number(cmd.cursor) : 0;
      const end = Math.min(start + cmd.limit, messages.length);
      const page = messages.slice(start, end);
      return {
        type: 'response',
        id: cmd.id,
        command: 'get_messages_page',
        success: true,
        data: {
          messages: page,
          nextCursor: end < messages.length ? String(end) : undefined,
          totalMessages: messages.length,
        },
      };
    },
  };
}

describe('fetchAllMessages', () => {
  it('returns everything in one page when it all fits under the page size', async () => {
    const messages = [userMessage('a'), userMessage('b'), userMessage('c')];
    const result = await fetchAllMessages(fakeServer(messages));
    expect(result.complete).toBe(true);
    expect(result.messages).toEqual(messages);
  });

  it('reports an empty history as complete', async () => {
    const result = await fetchAllMessages(fakeServer([]));
    expect(result).toEqual({ messages: [], complete: true });
  });

  it('follows nextCursor across multiple pages and assembles them in order', async () => {
    const messages = Array.from({ length: 450 }, (_, i) => userMessage(`msg-${i}`));
    const result = await fetchAllMessages(fakeServer(messages));
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(450);
    expect(result.messages).toEqual(messages);
  });

  it('never sends the offset field (confirmed-dead parameter, FINDINGS item 47)', async () => {
    const messages = [userMessage('a')];
    let sawOffset = false;
    const spy: MessagesPageRequester = {
      async request(cmd) {
        if ('offset' in cmd) sawOffset = true;
        return fakeServer(messages).request(cmd);
      },
    };
    await fetchAllMessages(spy);
    expect(sawOffset).toBe(false);
  });

  it('returns incomplete with the partial messages already fetched when a LATER page throws (no fallback -- get_messages_page already proved it works this run)', async () => {
    const messages = Array.from({ length: 450 }, (_, i) => userMessage(`msg-${i}`));
    const real = fakeServer(messages);
    let calls = 0;
    const flaky: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        if (calls === 2) throw new Error('network blip');
        return real.request(cmd);
      },
    };
    const result = await fetchAllMessages(flaky);
    expect(result.complete).toBe(false);
    expect(result.messages).toHaveLength(MESSAGES_PAGE_SIZE); // exactly the first page
  });

  it('returns incomplete with the partial messages already fetched when a LATER page is malformed', async () => {
    const messages = Array.from({ length: 450 }, (_, i) => userMessage(`msg-${i}`));
    const real = fakeServer(messages);
    let calls = 0;
    const flaky: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        if (calls === 2) return { type: 'response', id: cmd.id, command: 'get_messages_page', success: true, data: { totalMessages: 450 } };
        return real.request(cmd);
      },
    };
    const result = await fetchAllMessages(flaky);
    expect(result.complete).toBe(false);
    expect(result.messages).toHaveLength(MESSAGES_PAGE_SIZE);
  });

  // Quality-gate fix (cycle 2, 2026-10-08): get_messages_page is only confirmed on omp 18.8.0.
  // A FIRST-page failure (any shape -- thrown, success:false, or malformed) falls back to one
  // plain get_messages call instead, since there is nothing paginated to lose yet.
  it('falls back to get_messages when the FIRST page throws, and the fallback succeeds', async () => {
    const messages = [userMessage('a'), userMessage('b')];
    const real = fakeServer(messages);
    const brokenFirstPage: MessagesPageRequester = {
      async request(cmd) {
        if (cmd.type === 'get_messages_page') throw new Error('unknown command');
        return real.request(cmd);
      },
    };
    const result = await fetchAllMessages(brokenFirstPage);
    expect(result).toEqual({ messages, complete: true });
  });

  it('falls back to get_messages when the FIRST page responds success:false, and the fallback succeeds', async () => {
    const messages = [userMessage('a')];
    const real = fakeServer(messages);
    const brokenFirstPage: MessagesPageRequester = {
      async request(cmd) {
        if (cmd.type === 'get_messages_page') return { type: 'response', id: cmd.id, command: 'get_messages_page', success: false, error: 'unknown command' };
        return real.request(cmd);
      },
    };
    const result = await fetchAllMessages(brokenFirstPage);
    expect(result).toEqual({ messages, complete: true });
  });

  it('falls back to get_messages when the FIRST page is malformed (non-array messages), and the fallback succeeds', async () => {
    const messages = [userMessage('a')];
    const real = fakeServer(messages);
    const brokenFirstPage: MessagesPageRequester = {
      async request(cmd) {
        if (cmd.type === 'get_messages_page') return { type: 'response', id: cmd.id, command: 'get_messages_page', success: true, data: { messages: 'not-an-array', totalMessages: 1 } };
        return real.request(cmd);
      },
    };
    const result = await fetchAllMessages(brokenFirstPage as MessagesPageRequester);
    expect(result).toEqual({ messages, complete: true });
  });

  it('returns incomplete, empty messages, when BOTH the first page and its get_messages fallback fail', async () => {
    const flaky: MessagesPageRequester = {
      async request(cmd) {
        return { type: 'response', id: cmd.id, command: cmd.type, success: false, error: 'boom' };
      },
    };
    const result = await fetchAllMessages(flaky);
    expect(result).toEqual({ messages: [], complete: false });
  });

  it('stops once the accumulated count reaches totalMessages even if nextCursor is still present', async () => {
    const messages = [userMessage('a'), userMessage('b')];
    const stubborn: MessagesPageRequester = {
      async request(cmd) {
        return {
          type: 'response',
          id: cmd.id,
          command: 'get_messages_page',
          success: true,
          data: { messages, nextCursor: 'still-more', totalMessages: messages.length },
        };
      },
    };
    const result = await fetchAllMessages(stubborn);
    expect(result.complete).toBe(true);
    expect(result.messages).toEqual(messages);
  });

  // Quality-gate fix (cycle 2, 2026-10-08): `complete` must be true ONLY once the accumulated
  // count reaches `totalMessages` -- a cursor that stops appearing before that point is a
  // genuinely partial fetch, never reported as a success (the old code returned `complete:true`
  // here, silently replacing the full transcript with a partial one).
  it('reports incomplete when nextCursor disappears before totalMessages is reached', async () => {
    const page1 = Array.from({ length: MESSAGES_PAGE_SIZE }, (_, i) => userMessage(`msg-${i}`));
    let calls = 0;
    const droppedCursor: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        return {
          type: 'response',
          id: cmd.id,
          command: 'get_messages_page',
          success: true,
          // Claims 450 total but stops offering a cursor after the first page of 200 -- a
          // server bug, or (hypothetically) a Conversation that shrank mid-fetch.
          data: { messages: calls === 1 ? page1 : [], nextCursor: undefined, totalMessages: 450 },
        };
      },
    };
    const result = await fetchAllMessages(droppedCursor);
    expect(result.complete).toBe(false);
    expect(result.messages).toHaveLength(MESSAGES_PAGE_SIZE);
  });

  // Quality-gate fix (cycle 2, 2026-10-08): an empty page while a cursor is still offered makes
  // no progress -- stop at once (in exactly one request) rather than spending up to 10,000
  // blocking round trips finding that out the slow way.
  it('stops immediately (one request) when a page is empty but still offers a cursor', async () => {
    let calls = 0;
    const stuck: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        return {
          type: 'response',
          id: cmd.id,
          command: 'get_messages_page',
          success: true,
          data: { messages: [], nextCursor: 'loop-forever', totalMessages: 999_999_999 },
        };
      },
    };
    const result = await fetchAllMessages(stuck);
    expect(result.complete).toBe(false);
    expect(calls).toBe(1);
  });

  it('stops immediately (one request) when the exact same cursor is offered twice', async () => {
    let calls = 0;
    const page1 = [userMessage('a')];
    const stuck: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        return {
          type: 'response',
          id: cmd.id,
          command: 'get_messages_page',
          // Offers a non-empty page every time, but the SAME cursor each time -- a server bug
          // distinct from the empty-page case above.
          success: true,
          data: { messages: page1, nextCursor: 'same-cursor-every-time', totalMessages: 999_999_999 },
        };
      },
    };
    const result = await fetchAllMessages(stuck);
    expect(result.complete).toBe(false);
    expect(calls).toBe(2); // the first call's cursor is unknown yet; the second repeats it and is caught
  });

  it('gives up after the safety cap when a server keeps genuinely paginating but never reaches totalMessages', async () => {
    let calls = 0;
    const neverEnding: MessagesPageRequester = {
      async request(cmd) {
        calls += 1;
        return {
          type: 'response',
          id: cmd.id,
          command: 'get_messages_page',
          success: true,
          // A new message and a new (always-different) cursor every call -- genuine progress,
          // but totalMessages is unreachably large, so the cap is the only thing that stops it.
          data: { messages: [userMessage(`msg-${calls}`)], nextCursor: `cursor-${calls}`, totalMessages: 999_999_999 },
        };
      },
    };
    const result = await fetchAllMessages(neverEnding);
    expect(result.complete).toBe(false);
    expect(calls).toBe(10_000);
  });
});
