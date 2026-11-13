import { describe, expect, it } from 'vitest';
import { imagePartCount, lastToolResultText, requestModelId, systemText, toolResultTexts } from './observe.mjs';

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

