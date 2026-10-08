// Issue #510 slice 4 (PLAN.md row A0): regression coverage for the "Load earlier" window.
import { describe, it, expect } from 'vitest';
import { windowTranscriptTurns, INITIAL_VISIBLE_TURN_COUNT, restoreScrollTop, loadEarlierAnnouncement } from './windowTranscriptTurns';

describe('windowTranscriptTurns', () => {
  it('shows everything, with no hidden count, when there are fewer turns than the limit', () => {
    const turns = Array.from({ length: 5 }, (_, i) => i);
    const result = windowTranscriptTurns(turns, false);
    expect(result.visible).toEqual(turns);
    expect(result.hiddenCount).toBe(0);
  });

  it('shows everything when there are exactly the limit of turns', () => {
    const turns = Array.from({ length: INITIAL_VISIBLE_TURN_COUNT }, (_, i) => i);
    const result = windowTranscriptTurns(turns, false);
    expect(result.visible).toEqual(turns);
    expect(result.hiddenCount).toBe(0);
  });

  it('hides the earliest turns, keeping the most recent, when over the limit and not revealed', () => {
    const turns = Array.from({ length: INITIAL_VISIBLE_TURN_COUNT + 30 }, (_, i) => i);
    const result = windowTranscriptTurns(turns, false);
    expect(result.hiddenCount).toBe(30);
    expect(result.visible).toHaveLength(INITIAL_VISIBLE_TURN_COUNT);
    // The LAST turn (most recent, possibly still running) is always kept.
    expect(result.visible[result.visible.length - 1]).toBe(turns[turns.length - 1]);
    // The hidden ones are the oldest, never the newest.
    expect(result.visible[0]).toBe(turns[30]);
  });

  it('reveals everything once revealed is true, regardless of count', () => {
    const turns = Array.from({ length: INITIAL_VISIBLE_TURN_COUNT + 30 }, (_, i) => i);
    const result = windowTranscriptTurns(turns, true);
    expect(result.visible).toEqual(turns);
    expect(result.hiddenCount).toBe(0);
  });

  it('never throws on an empty transcript', () => {
    expect(windowTranscriptTurns([], false)).toEqual({ visible: [], hiddenCount: 0 });
  });
});

// Quality-gate fix (test-reviewer, Medium, cycle 3, 2026-10-08): the "Load earlier" scroll-anchor
// arithmetic and announcement text, pulled out of Transcript.tsx so they are unit-testable
// without a real DOM/jsdom.
describe('restoreScrollTop', () => {
  it('restores the same distance from the end after new content grows scrollHeight', () => {
    // Developer was 500px from the end (scrollHeight 2000, scrollTop 1500); 3000px of newly
    // revealed content is inserted above, growing scrollHeight to 5000.
    expect(restoreScrollTop(5000, 500)).toBe(4500);
  });

  it('restores to 0 when the anchor was already at the very end', () => {
    expect(restoreScrollTop(5000, 0)).toBe(5000);
  });
});

describe('loadEarlierAnnouncement', () => {
  it('uses singular wording for exactly one turn', () => {
    expect(loadEarlierAnnouncement(1)).toBe('Loaded 1 earlier turn.');
  });

  it('uses plural wording for any other count', () => {
    expect(loadEarlierAnnouncement(0)).toBe('Loaded 0 earlier turns.');
    expect(loadEarlierAnnouncement(2)).toBe('Loaded 2 earlier turns.');
    expect(loadEarlierAnnouncement(347)).toBe('Loaded 347 earlier turns.');
  });
});
