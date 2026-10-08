// Issue #510 slice 4 (PLAN.md row A0): replaces a single, unbounded `get_messages` round trip
// with several bounded-size `get_messages_page` ones, confirmed real on omp 18.8.0
// (docs/spike/FINDINGS.md item 47). Only the server's own `nextCursor` is ever followed --
// never a hand-built one, and never the `offset` field, which the probe confirmed is silently
// ignored. Pulled out of `SessionAgent.ts` (both `launch()` and `openConversation()` call it) so
// the pagination/termination logic is unit-testable against a fake `request`, without a real
// OmpProcess or a live omp binary.
import type { OmpMessage, GetMessagesPageResponseData, ResponseFrame, RpcCommand } from '../../shared/frames';

/** The one piece of `OmpProcess` this needs -- narrowed so a test can supply a fake without
 * constructing a real process. */
export interface MessagesPageRequester {
  request(cmd: RpcCommand, timeoutMs?: number): Promise<ResponseFrame>;
}

export const MESSAGES_PAGE_SIZE = 200;

export interface FetchAllMessagesResult {
  messages: OmpMessage[];
  /** True only once the accumulated count reaches the server's own `totalMessages` with every
   * page request succeeding along the way. `false` on any failed/thrown page (even if some
   * messages were already fetched before the failure) or if the safety-cap loop limit is hit --
   * mirrors the old single-call `get_messages`'s own `success` flag: a caller must never
   * silently replace an existing in-memory transcript with a partial one just because SOME
   * messages came back. */
  complete: boolean;
}

/** Fetches the full message history, oldest first, in `MESSAGES_PAGE_SIZE`-sized pages. Never
 * throws -- a failed or errored page stops the loop and returns whatever was already fetched
 * with `complete: false` (the caller already treats that the same way a failed plain
 * `get_messages` always has). The `page` loop itself is capped at 10,000 iterations (2,000,000
 * messages at this page size, far beyond any real Conversation -- the forensic 48 MB session
 * this issue is named for had a few thousand lines) purely as a guard against a server bug that
 * returns the same cursor forever; it never fires in real use. */
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
      console.error('fetchAllMessages: get_messages_page threw', err);
      return { messages: all, complete: false };
    }
    if (!res.success) {
      console.error('fetchAllMessages: get_messages_page failed', res.error);
      return { messages: all, complete: false };
    }
    const data = res.data as GetMessagesPageResponseData;
    all.push(...data.messages);
    if (!data.nextCursor || all.length >= data.totalMessages) return { messages: all, complete: true };
    cursor = data.nextCursor;
  }
  console.error('fetchAllMessages: exceeded the page safety cap; treating as incomplete');
  return { messages: all, complete: false };
}
