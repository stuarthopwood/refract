// Builds a per-subagent TranscriptItem[] stream from OMP's own `tool_execution_update` progress
// entries (spec 004 FR-017/FR-018, contracts/omp-usage.md section (c), FINDINGS item 36). Pure:
// no I/O, no Electron imports. Mirrors transcript.ts's own "upsert by stable id, return a new
// array, never mutate the input" pattern, applied per subagent id instead of per Session.

import type { TranscriptItem } from '../../shared/model';
import type { ToolExecutionUpdateFrame } from '../../shared/frames';

type SubagentProgress = ToolExecutionUpdateFrame['partialResult']['details']['progress'][number];

/** `recentTools[]` entries carry no id of their own (FINDINGS item 36): `endMs` (the call's own
 * end timestamp) plus the tool name is the closest stable key the wire shape offers, so a call
 * already rendered is never duplicated as the same subagent's `recentTools` window grows. */
function toolItemId(subagentId: string, entry: { tool: string; endMs: number }): string {
  return `subagent-tool:${subagentId}:${entry.endMs}:${entry.tool}`;
}

function toolArgsPreview(entry: { args?: unknown; intent?: string; tool: string }): string {
  if (typeof entry.args === 'string') return entry.args;
  return entry.intent ?? entry.tool;
}

/** `recentOutput[]`'s populated element shape was never observed live (FINDINGS item 36 notes
 * both probe subagents replied via the `yield` tool, never plain text) -- read defensively: a
 * plain string, or a common `{text}`/`{content}` wrapper; anything else is skipped rather than
 * guessed at. */
function outputText(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
  }
  return undefined;
}

/** Applies one subagent's latest `tool_execution_update` progress entry to its own stream,
 * upserting a `tool` item per new `recentTools[]` entry and an `assistant-text` item per new
 * (defensively-read) `recentOutput[]` entry. Returns the same array reference when nothing new
 * is found, so callers can skip a patch. */
export function applySubagentProgress(items: TranscriptItem[], subagentId: string, progress: SubagentProgress): TranscriptItem[] {
  let next = items;

  for (const entry of progress.recentTools ?? []) {
    const id = toolItemId(subagentId, entry);
    if (next.some((item) => item.id === id)) continue;
    const toolItem: TranscriptItem = {
      kind: 'tool',
      id,
      toolCallId: id,
      tool: entry.tool,
      target: toolArgsPreview(entry),
      status: entry.isError ? 'error' : 'done',
      args: entry.args,
    };
    next = [...next, toolItem];
  }

  const recentOutput = progress.recentOutput ?? [];
  for (let i = 0; i < recentOutput.length; i++) {
    const id = `subagent-output:${subagentId}:${i}`;
    if (next.some((item) => item.id === id)) continue;
    const text = outputText(recentOutput[i]);
    if (text === undefined) continue;
    const textItem: TranscriptItem = { kind: 'assistant-text', id, text, streaming: false };
    next = [...next, textItem];
  }

  return next;
}
