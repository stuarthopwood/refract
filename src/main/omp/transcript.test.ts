// Issue #510 slice 3 (PLAN.md row A0): regression coverage for fromHistory's terminatedUnexpectedly
// gating -- a quality-gate finding (Medium, 2026-10-08) that none of slice 2/3's logic was tested.
import { describe, it, expect } from 'vitest';
import { fromHistory } from './transcript';
import type { OmpMessage } from '../../shared/frames';

function toolCallMessages(): OmpMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] },
  ];
}

describe('fromHistory terminatedUnexpectedly gating', () => {
  it('leaves an unresolved tool call "running" when terminatedUnexpectedly is false (default)', () => {
    const items = fromHistory(toolCallMessages(), new Set());
    const toolItem = items.find((item) => item.kind === 'tool');
    expect(toolItem?.status).toBe('running');
  });

  it('settles an unresolved tool call to "interrupted" when terminatedUnexpectedly is true', () => {
    const items = fromHistory(toolCallMessages(), new Set(), true);
    const toolItem = items.find((item) => item.kind === 'tool');
    expect(toolItem?.status).toBe('interrupted');
  });

  it('leaves a RESOLVED tool call "done" even when terminatedUnexpectedly is true', () => {
    const messages: OmpMessage[] = [
      ...toolCallMessages(),
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
    ];
    const items = fromHistory(messages, new Set(), true);
    const toolItem = items.find((item) => item.kind === 'tool');
    expect(toolItem?.status).toBe('done');
  });
});
