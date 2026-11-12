// In-process OpenAI-compatible mock model for the #1835 live check; no real model is ever called.
// Parent turns: a user message containing "SPAWN" makes the agent call the `task` tool (two subagents for "SPAWN NOW",
// one for "SPAWN LATE"); "HOLD" in that message parks the reply until `release()`, so the driver can Pause mid-turn.
// Subagent requests (their first user-side message carries SUBAGENT_MARKER) are held open until the client aborts,
// which is what a long-running subagent looks like to omp: it stays "running" until Refract cancels it.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

export const SUBAGENT_MARKER = 'LONGRUN-SUBAGENT';

function startSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

const chunk = (delta, finish) => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'probe-model',
  choices: [{ index: 0, delta, finish_reason: finish ?? null }]
});

function sendChunks(res, chunks) {
  startSse(res);
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content));

function taskCall(callId, names) {
  const args = {
    i: 'Starting long-running subagents',
    context: 'Verification fixture: each subagent waits on the model for a long time.',
    tasks: names.map((name) => ({ name, task: `${SUBAGENT_MARKER} ${name}: wait for the model.`, solutionSpace: 'one fix: none, the subagent only waits' }))
  };
  const call = { index: 0, id: callId, type: 'function', function: { name: 'task', arguments: '' } };
  return [
    chunk({ role: 'assistant', content: null, tool_calls: [call] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    chunk({}, 'tool_calls')
  ];
}

/** Resolves once listening. `requests` is every request; `subagents` tracks each held subagent request and when it was aborted. */
export function startMockModel({ port, logFile }) {
  const requests = [];
  const subagents = [];
  let held = 0;
  let releaseGate = () => {};
  let gate = new Promise((resolve) => (releaseGate = resolve));
  let calls = 0;
  const log = (entry) => logFile && appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + '\n');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[]}');
      }
      let json = {};
      try {
        json = JSON.parse(body);
      } catch {}
      const messages = json.messages || [];
      const last = messages[messages.length - 1];
      const lastText = last ? textOf(last.content) : '';
      const isSubagent = messages.some((m) => (m.role === 'user' || m.role === 'system') && textOf(m.content).includes(SUBAGENT_MARKER));
      const entry = { kind: isSubagent ? 'subagent' : 'parent', tools: (json.tools || []).map((t) => t.function?.name), lastRole: last?.role, lastContent: lastText.slice(0, 400) };
      requests.push(entry);
      log(entry);

      if (isSubagent) {
        const record = { startedAt: Date.now(), abortedAt: null, label: (lastText.match(/LONGRUN-SUBAGENT (\w+)/) || [])[1] ?? null };
        subagents.push(record);
        startSse(res);
        const keepAlive = setInterval(() => res.write(': waiting\n\n'), 5000);
        res.on('close', () => {
          clearInterval(keepAlive);
          record.abortedAt = Date.now();
          log({ kind: 'subagent-request-closed', label: record.label });
        });
        return;
      }

      if (last?.role === 'user' && lastText.includes('SPAWN')) {
        if (lastText.includes('HOLD')) {
          held += 1;
          log({ kind: 'parent-held' });
          await gate;
        }
        calls += 1;
        return sendChunks(res, taskCall(`call_task_${calls}`, lastText.includes('LATE') ? ['SlowThree'] : ['SlowOne', 'SlowTwo']));
      }
      return sendChunks(res, [chunk({ role: 'assistant', content: 'Acknowledged.' }), chunk({}, 'stop')]);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        requests,
        subagents,
        heldCount: () => held,
        release: () => releaseGate(),
        rearm: () => {
          gate = new Promise((r) => (releaseGate = r));
        }
      })
    );
  });
}
