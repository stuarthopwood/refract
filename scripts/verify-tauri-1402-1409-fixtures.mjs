// Fixtures for scripts/verify-tauri-1402-1409.mjs: a synthetic OMP sessions folder with a Session
// directory (main + nested subagent file), a similarly named sibling directory, and an `__advisor`
// file on a model that differs from the Advisor role; plus the WATCHDOG.yml roster.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CWD = 'C:\\Work\\verify1402proj';
const entry = (value) => `${JSON.stringify(value)}\n`;
const iso = (ms) => new Date(ms).toISOString();

function assistant(id, ts, usage, cost, { toolCallId, model = 'claude-sonnet' } = {}) {
  const content = [{ type: 'text', text: 'ok' }];
  if (toolCallId) content.push({ type: 'toolCall', id: toolCallId, name: 'bash', arguments: {} });
  return entry({
    type: 'message',
    id,
    timestamp: iso(ts),
    message: {
      role: 'assistant',
      content,
      timestamp: ts,
      model,
      provider: 'github-copilot',
      usage: {
        input: usage[0],
        output: usage[1],
        cacheRead: usage[2],
        cacheWrite: 0,
        totalTokens: usage[0] + usage[1] + usage[2],
        cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost }
      }
    }
  });
}

const toolResult = (id, ts, callId, isError) =>
  entry({ type: 'message', id, timestamp: iso(ts), message: { role: 'toolResult', toolCallId: callId, isError, content: [{ type: 'text', text: 'out' }] } });

const header = (id, ts) => entry({ type: 'session', id, timestamp: iso(ts), cwd: CWD });

/** Counts the Session directory must report: the sibling's two big calls must NOT be in them. */
export const EXPECT_SESSION = { calls: 4, totalTokens: 360, spendUsd: 0.1, toolCalls: 2 };
export const EXPECT_ALL = { calls: 6 };
export const ADVISOR_MODEL = 'roster-only-model';
export const ROSTER_MODELS = ['github-copilot/claude-opus-5', 'openai-codex/gpt-6-sol'];

export const ROSTER_YAML = `advisors:
  - name: security-watch
    model: ${ROSTER_MODELS[0]}
  - name: perf-watch
    model: ${ROSTER_MODELS[1]}
`;

/** Writes the populated fixture; returns the Session directory and the main file (the fake omp's conversation file). */
export function writePopulatedSessions(root) {
  const now = Date.now();
  const sessionDir = path.join(root, 'x-foo');
  mkdirSync(path.join(sessionDir, 'main'), { recursive: true });
  const mainFile = path.join(sessionDir, 's1.jsonl');
  writeFileSync(
    mainFile,
    header('s1', now - 3 * 3600_000) +
      assistant('a1', now - 3 * 3600_000 + 1000, [10, 5, 100], 0.03, { toolCallId: 'tc1' }) +
      toolResult('r1', now - 3 * 3600_000 + 2000, 'tc1', false) +
      assistant('a2', now - 2 * 3600_000, [20, 10, 200], 0.05, { toolCallId: 'tc2' }) +
      toolResult('r2', now - 2 * 3600_000 + 1000, 'tc2', true) +
      assistant('a3', now - 2 * 3600_000 + 5000, [4, 1, 0], 0.01)
  );
  writeFileSync(path.join(sessionDir, 'main', '0-Sub.jsonl'), header('s2', now - 3600_000) + assistant('b1', now - 3600_000 + 1000, [7, 3, 0], 0.01));
  const siblingDir = path.join(root, 'x-foo-bar');
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(
    path.join(siblingDir, 's3.jsonl'),
    header('s3', now - 3600_000) + assistant('c1', now - 3000_000, [1000, 500, 0], 1) + assistant('c2', now - 2900_000, [1000, 500, 0], 1)
  );
  const advisorDir = path.join(root, 'x-adv');
  mkdirSync(advisorDir, { recursive: true });
  writeFileSync(
    path.join(advisorDir, 's9__advisor.jsonl'),
    header('s9', now - 1800_000) + assistant('d1', now - 1700_000, [5, 5, 0], 0.01, { model: ADVISOR_MODEL })
  );
  return { sessionDir, mainFile };
}

/** A Session directory whose only file has a header and no model calls. */
export function writeEmptySessions(root) {
  const sessionDir = path.join(root, 'x-empty');
  mkdirSync(sessionDir, { recursive: true });
  const mainFile = path.join(sessionDir, 's1.jsonl');
  writeFileSync(mainFile, header('e1', Date.now() - 3600_000));
  return { sessionDir, mainFile };
}
