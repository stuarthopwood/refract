// Tool-output probes (#1935 T007, T008): the observable is the text of the tool result omp feeds back to the model.
import { toolCallTwice } from './helpers.mjs';

const NEEDLE_FILE = Array.from({ length: 400 }, (_, i) => (i === 200 ? 'NEEDLE here' : `line ${i + 1}`)).join('\n') + '\n';
const CODE_FILE = Array.from({ length: 120 }, (_, i) => `export function fn${i}(a, b) {\n  const x = a + b + ${i};\n  return x * 2;\n}\n`).join('\n');
const FILES = { 'needle.txt': NEEDLE_FILE, 'code.js': CODE_FILE };

const GREP = { name: 'grep', args: { pattern: 'NEEDLE', path: 'needle.txt' } };
const READ_TEXT = { name: 'read', args: { path: 'needle.txt' } };
const READ_CODE = { name: 'read', args: { path: 'code.js' } };

const text = (t) => t ?? null;
const numberedRows = (t) => (t == null ? null : `${(t.match(/^\d+:/gm) ?? []).length} numbered rows`);
const elisions = (t) => (t == null ? null : `${(t.match(/\{ … \}/g) ?? []).length} collapsed bodies`);
// Why: the spill marker is the only thing that proves the output left the conversation; the rest is bulk bytes.
const spilled = (t) => (t == null ? null : t.includes('artifact://') ? 'spilled to artifact' : 'inline');

// ~30 KB of output, between the 10 KB and 100 KB thresholds the probe moves between.
const BIG_OUTPUT = { name: 'bash', args: { command: `node -e "process.stdout.write('abcdefghi\\\\n'.repeat(3000))"` } };

export const toolResultsGroup = {
  description: 'grep context lines and read limits, observed as the tool result text of the next turn',
  keys: [
    {
      key: 'grep.contextBefore',
      observable: 'grep tool result text, turn 1 vs turn 2',
      run: (ctx) => toolCallTwice(ctx, { baseline: { 'grep.contextBefore': 0, 'grep.contextAfter': 0 }, call: GREP, files: FILES, key: 'grep.contextBefore', value: 3, shape: text }),
    },
    {
      key: 'grep.contextAfter',
      observable: 'grep tool result text, turn 1 vs turn 2',
      run: (ctx) => toolCallTwice(ctx, { baseline: { 'grep.contextBefore': 0, 'grep.contextAfter': 0 }, call: GREP, files: FILES, key: 'grep.contextAfter', value: 3, shape: text }),
    },
    {
      key: 'read.defaultLimit',
      observable: 'numbered rows in the read tool result, turn 1 vs turn 2',
      run: (ctx) => toolCallTwice(ctx, { baseline: { 'read.defaultLimit': 300 }, call: READ_TEXT, files: FILES, key: 'read.defaultLimit', value: 50, shape: numberedRows }),
    },
    {
      key: 'read.summarize.enabled',
      observable: 'collapsed function bodies in the read tool result, turn 1 vs turn 2',
      run: (ctx) => toolCallTwice(ctx, { baseline: { 'read.summarize.enabled': true }, call: READ_CODE, files: FILES, key: 'read.summarize.enabled', value: false, shape: elisions }),
    },
  ],
};

export const artifactSpillGroup = {
  description: 'artifact spill threshold, observed as an artifact:// marker in the bash tool result',
  keys: [
    {
      key: 'tools.artifactSpillThreshold',
      observable: 'artifact:// marker in a ~30 KB bash result, turn 1 (10 KB threshold) vs turn 2 (100 KB threshold)',
      run: (ctx) => toolCallTwice(ctx, { baseline: { 'tools.artifactSpillThreshold': 10 }, call: BIG_OUTPUT, key: 'tools.artifactSpillThreshold', value: 100, shape: spilled }),
    },
  ],
};

