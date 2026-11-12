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
