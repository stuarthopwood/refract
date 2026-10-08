// Issue #510 slice 4 (PLAN.md row A0): replaces a single, unbounded `get_messages` round trip
// with several bounded-size `get_messages_page` ones, confirmed real on omp 18.8.0
// (docs/spike/FINDINGS.md item 47). Only the server's own `nextCursor` is ever followed --
// never a hand-built one, and never the `offset` field, which the probe confirmed is silently
// ignored. Pulled out of `SessionAgent.ts` (both `launch()` and `openConversation()` call it) so
// the pagination/termination logic is unit-testable against a fake `request`, without a real
// OmpProcess or a live omp binary.
import type { OmpMessage, GetMessagesPageResponseData, GetMessagesResponseData, ResponseFrame, RpcCommand } from '../../shared/frames';

/** The one piece of `OmpProcess` this needs -- narrowed so a test can supply a fake without
 * constructing a real process. */
export interface MessagesPageRequester {
  request(cmd: RpcCommand, timeoutMs?: number): Promise<ResponseFrame>;
}

export const MESSAGES_PAGE_SIZE = 200;

export interface FetchAllMessagesResult {
  messages: OmpMessage[];
  /** True only once the accumulated count reaches the server's own `totalMessages` with every
   * page request succeeding along the way. `false` on any failed/thrown/malformed page (even if
   * some messages were already fetched before the failure), a cursor that stops appearing before
   * the count is reached, a page that makes no progress, or the safety-cap loop limit --
   * mirrors the old single-call `get_messages`'s own `success` flag: a caller must never
   * silently replace an existing in-memory transcript with a partial one just because SOME
   * messages came back. */
  complete: boolean;
}

/** Quality-gate fix (cycle 2, 2026-10-08): `get_messages_page` is confirmed real only on omp
 * 18.8.0 (FINDINGS item 47); `readiness.ts` still accepts any 18.x, including 18.4/18.5, where
 * this command is unprobed and may not exist at all. If the very FIRST page fails -- before any
 * messages have been fetched at all, so there is nothing paginated to lose -- falls back to one
 * plain `get_messages` call instead, which every supported version is confirmed to have. A LATER
 * page failing (after some pages already succeeded) does not retry this way: that is a
 * mid-stream failure on a command already confirmed to work this run, not a version gap, so the
 * existing "stop and report incomplete" behaviour is correct for it. */
async function fallbackToGetMessages(proc: MessagesPageRequester): Promise<FetchAllMessagesResult> {
  let res: ResponseFrame;
  try {
    res = await proc.request({ type: 'get_messages', id: '' });
  } catch (err) {
    console.error('fetchAllMessages: get_messages fallback threw', err);
    return { messages: [], complete: false };
  }
  if (!res.success || !Array.isArray((res.data as GetMessagesResponseData | undefined)?.messages)) {
    console.error('fetchAllMessages: get_messages fallback failed', res.error);
    return { messages: [], complete: false };
  }
  return { messages: (res.data as GetMessagesResponseData).messages, complete: true };
}

/** Fetches the full message history, oldest first, in `MESSAGES_PAGE_SIZE`-sized pages. Never
 * throws -- a failed, errored, or malformed page stops the loop and returns whatever was already
 * fetched with `complete: false` (the caller already treats that the same way a failed plain
 * `get_messages` always has). The `page` loop itself is capped at 10,000 iterations (2,000,000
 * messages at this page size, far beyond any real Conversation -- the forensic 48 MB session
 * this issue is named for had a few thousand lines) purely as a last-resort guard; the stuck-
 * cursor check below stops a non-progressing server in at most two requests, long before this
 * cap could ever matter in practice. */
export async function fetchAllMessages(proc: MessagesPageRequester): Promise<FetchAllMessagesResult> {
  const all: OmpMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    let res: ResponseFrame;
    try {
      res = await proc.request({
        type: 'get_messages_page',
        id: '',
        limit: MESSAGES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
    } catch (err) {
      if (page === 0) return fallbackToGetMessages(proc);
      console.error('fetchAllMessages: get_messages_page threw', err);
      return { messages: all, complete: false };
    }
    if (!res.success) {
      if (page === 0) return fallbackToGetMessages(proc);
      console.error('fetchAllMessages: get_messages_page failed', res.error);
      return { messages: all, complete: false };
    }
    // Quality-gate fix (cycle 2): never trust the response's shape -- a non-array `messages` or
    // a missing/non-numeric `totalMessages` must never throw (breaking the "never throws"
    // contract this module promises every caller, including `openConversation()`, which has no
    // surrounding try/catch of its own) and must never be silently spread into `all` either.
    const data = res.data as GetMessagesPageResponseData | undefined;
    if (!data || !Array.isArray(data.messages) || typeof data.totalMessages !== 'number') {
      if (page === 0) return fallbackToGetMessages(proc);
      console.error('fetchAllMessages: get_messages_page returned a malformed page', data);
      return { messages: all, complete: false };
    }
    // Quality-gate fix (cycle 2): a page that returns nothing new (an empty page while a cursor
    // is still offered, or the exact same cursor back again) makes no progress -- stop at once
    // rather than spending up to 10,000 blocking round trips finding that out the slow way.
    if (data.nextCursor !== undefined && (data.messages.length === 0 || data.nextCursor === cursor)) {
      console.error('fetchAllMessages: get_messages_page made no progress; stopping');
      return { messages: all, complete: false };
    }
    all.push(...data.messages);
    if (all.length >= data.totalMessages) return { messages: all, complete: true };
    // Quality-gate fix (cycle 2): `complete` is true ONLY once the accumulated count reaches
    // `totalMessages` -- a cursor that stops appearing before that point is a genuinely partial
    // fetch, never reported as a success.
    if (!data.nextCursor) return { messages: all, complete: false };
    cursor = data.nextCursor;
  }
  console.error('fetchAllMessages: exceeded the page safety cap; treating as incomplete');
  return { messages: all, complete: false };
}
