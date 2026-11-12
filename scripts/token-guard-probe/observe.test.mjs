import { describe, expect, it } from 'vitest';
import {
  agentEndTimes,
  compactionStartsByReason,
  imagePartCount,
  inFlightPeak,
  lastToolResultText,
  markerInSystemText,
  requestModelId,
  requestsAfter,
  systemText,
  toolResultTexts,
} from './observe.mjs';

const body = {
  model: 'probe-model',
  messages: [
    { role: 'system', content: 'You are omp. EAGER-TODO-GUIDANCE' },
    { role: 'developer', content: [{ type: 'text', text: 'plan mode is active' }] },
    { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'line one\nline two' },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'second result' }] },
  ],
};

describe('request body extractors', () => {
  it('reads the model id, and null when absent', () => {
    expect(requestModelId(body)).toBe('probe-model');
    expect(requestModelId({})).toBeNull();
    expect(requestModelId(undefined)).toBeNull();
  });

  it('joins system and developer text across string and part content', () => {
    expect(systemText(body)).toBe('You are omp. EAGER-TODO-GUIDANCE\nplan mode is active');
    expect(systemText({ messages: [{ role: 'user', content: 'x' }] })).toBe('');
  });

  it('finds a marker only in system text, not in user or tool text', () => {
    expect(markerInSystemText(body, 'EAGER-TODO-GUIDANCE')).toBe(true);
    expect(markerInSystemText(body, 'plan mode is active')).toBe(true);
    expect(markerInSystemText(body, 'line one')).toBe(false);
  });

  it('counts image parts across messages', () => {
    expect(imagePartCount(body)).toBe(1);
    expect(imagePartCount({ messages: [{ role: 'user', content: 'plain' }] })).toBe(0);
    const two = { messages: [{ role: 'user', content: [{ type: 'input_image' }, { type: 'image' }] }] };
    expect(imagePartCount(two)).toBe(2);
  });

  it('lists tool results in order and returns the last', () => {
    expect(toolResultTexts(body)).toEqual(['line one\nline two', 'second result']);
    expect(lastToolResultText(body)).toBe('second result');
    expect(lastToolResultText({ messages: [] })).toBeNull();
  });
});

describe('frame extractors', () => {
  const records = [
    { at: 10, frame: { type: 'auto_compaction_start', reason: 'idle' } },
    { at: 20, frame: { type: 'auto_compaction_start', reason: 'threshold' } },
    { at: 30, frame: { type: 'auto_compaction_start', reason: 'idle' } },
    { at: 35, frame: { type: 'auto_compaction_start' } },
    { at: 40, frame: { type: 'auto_compaction_end', reason: 'idle' } },
    { at: 50, frame: { type: 'agent_end', isTerminal: true } },
    { at: 90, frame: { type: 'agent_end', isTerminal: true } },
  ];

  it('counts compaction starts by reason and ignores ends', () => {
    expect(compactionStartsByReason(records)).toEqual({ idle: 2, threshold: 1, unknown: 1 });
    expect(compactionStartsByReason([])).toEqual({});
  });

  it('collects agent_end times', () => {
    expect(agentEndTimes(records)).toEqual([50, 90]);
  });
});

describe('request timing extractors', () => {
  it('computes the peak of overlapping requests', () => {
    const requests = [
      { receivedAt: 0, closedAt: 100 },
      { receivedAt: 10, closedAt: 90 },
      { receivedAt: 20, closedAt: 30 },
      { receivedAt: 200, closedAt: 210 },
    ];
    expect(inFlightPeak(requests)).toBe(3);
  });

  it('does not count back-to-back requests as overlapping', () => {
    expect(inFlightPeak([{ receivedAt: 0, closedAt: 10 }, { receivedAt: 10, closedAt: 20 }])).toBe(1);
  });

  it('treats a never-closed request as open to the end', () => {
    expect(inFlightPeak([{ receivedAt: 0, closedAt: null }, { receivedAt: 5, closedAt: 6 }])).toBe(2);
    expect(inFlightPeak([])).toBe(0);
  });

  it('counts requests strictly after the agent end', () => {
    const requests = [{ receivedAt: 40 }, { receivedAt: 50 }, { receivedAt: 51 }, { receivedAt: 80 }];
    expect(requestsAfter(requests, 50)).toBe(2);
    expect(requestsAfter(requests, 100)).toBe(0);
  });
});
