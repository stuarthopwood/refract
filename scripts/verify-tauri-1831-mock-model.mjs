// In-process OpenAI-compatible mock model for the #1831 live check; no real model is ever called.
// A user message containing "SECOND" gets the small form B; any other user message gets form A. A tool result gets "Done.".
import http from 'node:http';
import { appendFileSync } from 'node:fs';

export const FORM_A = `<form>
<fieldset><legend>Which database?</legend>
<label><input type="radio" name="db" value="Postgres"> Postgres</label>
<label><input type="radio" name="db" value="SQLite"> SQLite</label>
</fieldset>
<fieldset><legend>Which features?</legend>
<label><input type="checkbox" name="features" value="Auth"> Auth</label>
<label><input type="checkbox" name="features" value="Billing"> Billing</label>
</fieldset>
<label for="why">Why this stack?</label><textarea id="why" name="why" required></textarea>
<label for="team">Team name</label><input type="text" id="team" name="team">
<label for="owner">Owner</label><input type="text" id="owner" name="owner" value="platform">
</form>`;

export const FORM_B = `<form>
<fieldset><legend>Proceed with the rollout?</legend>
<label><input type="radio" name="go" value="Yes"> Yes</label>
<label><input type="radio" name="go" value="No"> No</label>
</fieldset>
<label for="note">Note</label><input type="text" id="note" name="note">
</form>`;

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const chunk = (delta, finish) => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'probe-model',
  choices: [{ index: 0, delta, finish_reason: finish ?? null }]
});

const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content));

/** Resolves once listening; `requests` collects every request (tool names, last role, FULL last content). */
export function startMockModel({ port, logFile }) {
  const requests = [];
  let askCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[]}');
      }
      let json = {};
      try {
        json = JSON.parse(body);
      } catch {}
      const tools = (json.tools || []).map((t) => t.function?.name);
      const messages = json.messages || [];
      const last = messages[messages.length - 1];
      const entry = { url: req.url, tools, lastRole: last?.role, lastContent: last ? textOf(last.content) : null };
      requests.push(entry);
      if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n');
      if (last?.role === 'tool') return sse(res, [chunk({ role: 'assistant', content: 'Done.' }), chunk({}, 'stop')]);
      if (!tools.includes('ask')) return sse(res, [chunk({ role: 'assistant', content: 'ask tool not offered' }), chunk({}, 'stop')]);
      const html = textOf(last?.content).includes('SECOND') ? FORM_B : FORM_A;
      askCalls += 1;
      const call = { index: 0, id: `call_ask_${askCalls}`, type: 'function', function: { name: 'ask', arguments: '' } };
      sse(res, [
        chunk({ role: 'assistant', content: null, tool_calls: [call] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ html }) } }] }),
        chunk({}, 'tool_calls')
      ]);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, requests }));
  });
}
