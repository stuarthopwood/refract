// Pure extractors over recorded RPC frames and provider request bodies (#1935). Frame records are
// `{ at, frame }` (host.mjs); request records are `{ receivedAt, closedAt, body }` (provider.mjs).

const textOfParts = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' ? (p.text ?? '') : '')).join('');
};

// Why: omp sends the system prompt as `system` or, for newer OpenAI-compatible shapes, `developer`.
const isSystemRole = (m) => m?.role === 'system' || m?.role === 'developer';

export function requestModelId(body) {
  return typeof body?.model === 'string' ? body.model : null;
}

export function systemText(body) {
  return (body?.messages ?? []).filter(isSystemRole).map((m) => textOfParts(m.content)).join('\n');
}

export function markerInSystemText(body, marker) {
  return systemText(body).includes(marker);
}

/** Counts image content parts across every message (snapcompact sends images in place of text). */
export function imagePartCount(body) {
  let count = 0;
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) if (p?.type === 'image_url' || p?.type === 'input_image' || p?.type === 'image') count += 1;
  }
  return count;
}

/** Text of every `tool` role message, in order. */
export function toolResultTexts(body) {
  return (body?.messages ?? []).filter((m) => m?.role === 'tool').map((m) => textOfParts(m.content));
}

/** Text of the last tool result, or null when there is none. */
export function lastToolResultText(body) {
  const texts = toolResultTexts(body);
  return texts.length ? texts[texts.length - 1] : null;
}

/** `auto_compaction_start` frames grouped by `reason`; a frame without a reason counts under `unknown`. */
export function compactionStartsByReason(records) {
  const counts = {};
  for (const { frame } of records ?? []) {
    if (frame?.type !== 'auto_compaction_start') continue;
    const reason = typeof frame.reason === 'string' ? frame.reason : 'unknown';
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/** Receive times of every `agent_end` frame. */
export function agentEndTimes(records) {
  return (records ?? []).filter(({ frame }) => frame?.type === 'agent_end').map(({ at }) => at);
}

/** Maximum number of requests open at once; a request is open from `receivedAt` until `closedAt` (open-ended if null). */
export function inFlightPeak(requests) {
  const events = [];
  for (const r of requests ?? []) {
    events.push([r.receivedAt, 1]);
    if (r.closedAt != null) events.push([r.closedAt, -1]);
  }
  // Why: at an equal timestamp, closings sort first so back-to-back requests do not read as overlapping.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, delta] of events) {
    open += delta;
    if (open > peak) peak = open;
  }
  return peak;
}

/** Requests that arrive strictly after `agentEndAt` (autolearn's private capture follows the turn). */
export function requestsAfter(requests, agentEndAt) {
  return (requests ?? []).filter((r) => r.receivedAt > agentEndAt).length;
}
