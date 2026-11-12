// Scripted OpenAI-compatible chat/completions server for the token guard probes (#1935). No model runs:
// the script decides each response, so fan-out and ordering are exact. Every request body is recorded.
import http from 'node:http';

export const PROBE_PROVIDER_ID = 'probe-mock';
export const DEFAULT_MODEL_ID = 'probe-model';

const chunk = (delta, finish, extra = {}) => ({
  id: 'chatcmpl-probe',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: DEFAULT_MODEL_ID,
  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  ...extra,
});

const usageChunk = (usage) => ({ ...chunk({}, null), choices: [], usage });

/** Step -> SSE chunks. `usage` is optional so a probe can steer omp's token accounting. */
function chunksFor(step) {
  const calls = step.type === 'tool_call' ? [step] : (step.calls ?? []);
  const chunks =
    step.type === 'text'
      ? [chunk({ role: 'assistant', content: step.text ?? '' }), chunk({}, 'stop')]
      : [
          chunk({
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c, index) => ({ index, id: c.id ?? `call_probe_${index}`, type: 'function', function: { name: c.name, arguments: '' } })),
          }),
          ...calls.map((c, index) => chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(c.args ?? {}) } }] })),
          chunk({}, 'tool_calls'),
        ];
  if (step.usage) chunks.push(usageChunk(step.usage));
  return chunks;
}

/** Returns a script that plays `steps` in request order, then `fallback` (default: a short text reply). */
export function sequence(steps, fallback = { type: 'text', text: 'ok' }) {
  let i = 0;
  return () => (i < steps.length ? steps[i++] : fallback);
}

/**
 * Steps: `{type:'text', text}`, `{type:'tool_call', name, args, id?}`, `{type:'tool_calls', calls:[...]}`,
 * `{type:'hold', then?}` (parks until `release()`, then plays `then`), `{type:'hang'}` (parks until the client closes).
 * @param {{port?: number, script?: (record: object, index: number) => object | Promise<object>}} [options]
 */
export function startProvider({ port = 0, script = sequence([]) } = {}) {
  const requests = [];
  let currentScript = script;
  let gate = null;
  const newGate = () => {
    let open;
    const promise = new Promise((resolve) => (open = resolve));
    gate = { promise, open };
  };
  newGate();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[]}');
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Why: a malformed body is recorded as empty; the probe's observable then reads as missing.
      }
      const record = { index: requests.length, receivedAt: Date.now(), closedAt: null, body, stepType: null, held: false };
      requests.push(record);
      res.on('close', () => {
        record.closedAt = Date.now();
      });

      let step = await currentScript(record, record.index);
      record.stepType = step.type;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (step.type === 'hang' || step.type === 'hold') {
        record.held = true;
        const keepAlive = setInterval(() => res.write(': waiting\n\n'), 5000);
        const closed = new Promise((resolve) => res.once('close', () => resolve('closed')));
        const outcome = step.type === 'hang' ? await closed : await Promise.race([gate.promise.then(() => 'released'), closed]);
        clearInterval(keepAlive);
        record.held = false;
        if (outcome === 'closed') return;
        step = step.then ?? { type: 'text', text: 'released' };
      }
      for (const c of chunksFor(step)) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const boundPort = server.address().port;
      resolve({
        port: boundPort,
        baseUrl: `http://127.0.0.1:${boundPort}/v1`,
        requests,
        heldCount: () => requests.filter((r) => r.held).length,
        /** Releases every request parked by a `hold` step, and re-arms the gate for later holds. */
        release: () => {
          gate.open();
          newGate();
        },
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

/**
 * `models.yml` text pointing omp at the scripted provider. `vision` adds `input: [text, image]` so snapcompact
 * can send images; `contextWindow` is deliberately small so a probe can reach compaction thresholds cheaply.
 */
export function modelsYml({ port, models = [{ id: DEFAULT_MODEL_ID, vision: true }], contextWindow = 8000 }) {
  const lines = ['providers:', `  ${PROBE_PROVIDER_ID}:`, `    baseUrl: http://127.0.0.1:${port}/v1`, '    auth: none', '    api: openai-completions', '    models:'];
  for (const m of models) {
    lines.push(`      - id: ${m.id}`, `        name: ${m.id}`, '        api: openai-completions');
    if (m.vision) lines.push('        input: [text, image]');
    lines.push(`        contextWindow: ${m.contextWindow ?? contextWindow}`, '        maxTokens: 1000');
  }
  return `${lines.join('\n')}\n`;
}

/** `provider/model` selector for `modelRoles.*` and `--model`. */
export const modelSelector = (id = DEFAULT_MODEL_ID) => `${PROBE_PROVIDER_ID}/${id}`;
