// Issue #795 (lane R12b, part 3): golden tests proving `fromHistory`/`applyFrame` here and
// `TranscriptState::from_history`/`apply_frame` in Rust (transcript_golden.rs) produce
// byte-identical `TranscriptItem[]` JSON for the same input frames/history. Both readers read
// the SAME four fixture files under scripts/fixtures/transcript-golden/ (see that directory's
// README for provenance and the `startedAt`/`durationMs` normalization every reader applies).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromHistory, applyFrame } from './transcript';
import type { OmpMessage, Frame } from '../../shared/frames';
import type { TranscriptItem } from '../../shared/model';

const FIXTURE_DIR = resolve(__dirname, '../../../scripts/fixtures/transcript-golden');

// Wall-clock fields are never reproducible across runs/languages; see the fixture README's
// "Wall-clock fields are normalized, not golden" section. Identical walk in transcript_golden.rs.
function normalizeTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTiming);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === 'startedAt' || key === 'durationMs' ? 0 : normalizeTiming(v);
    }
    return out;
  }
  return value;
}

describe('transcript golden fixtures (issue #795, R12b part 3)', () => {
  it('fromHistory matches history-golden.json', () => {
    const messages = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'history-scenario.json'), 'utf8')) as OmpMessage[];
    const golden = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'history-golden.json'), 'utf8'));
    const items = fromHistory(messages, new Set());
    expect(normalizeTiming(items)).toEqual(golden);
  });

  it('applyFrame, folded over live-frames-scenario.json, matches live-frames-golden.json', () => {
    const frames = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'live-frames-scenario.json'), 'utf8')) as Frame[];
    const golden = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'live-frames-golden.json'), 'utf8'));
    let items: TranscriptItem[] = [];
    for (const frame of frames) {
      items = applyFrame(items, frame, false);
    }
    expect(normalizeTiming(items)).toEqual(golden);
  });
});
