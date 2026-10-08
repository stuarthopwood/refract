// Issue #510 slice 4 (PLAN.md row A0): regression coverage for fetchAllMessages's pagination
// and its "never throws, complete only when every page genuinely succeeded" contract.
import { describe, it, expect } from 'vitest';
import { fetchAllMessages } from './fetchAllMessages';
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

  it('returns incomplete with the partial messages already fetched when a later page throws', async () => {
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
    expect(result.messages).toHaveLength(200); // exactly the first page, MESSAGES_PAGE_SIZE
  });

  it('returns incomplete when a page responds success:false', async () => {
    const flaky: MessagesPageRequester = {
      async request(cmd) {
        return { type: 'response', id: cmd.id, command: 'get_messages_page', success: false, error: 'boom' };
      },
    };
    const result = await fetchAllMessages(flaky);
    expect(result.complete).toBe(false);
    expect(result.messages).toEqual([]);
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

  it('gives up after the safety cap if a server bug returns nextCursor forever with no real progress', async () => {
    const stuck: MessagesPageRequester = {
      async request(cmd) {
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
  });
});
