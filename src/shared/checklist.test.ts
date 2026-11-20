import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_CAPS,
  CHECKLIST_KEYS,
  FILE_KEYS,
  ITEM_KEYS,
  ITEM_OWNERS,
  ITEM_STATUSES,
  LAST_DEVELOPER_OP_KEYS,
  PENDING_COMPLETE_KEYS,
  RECENT_REQUEST_KEYS,
  REMOVED_KEYS,
  SEND_RECORD_KEYS,
  type ChecklistFile,
} from './checklist';

const rustDir = new URL('../../src-tauri/src/checklist/', import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, rustDir)), 'utf8');

const file = JSON.parse(read('fixtures/checklist-v1.json')) as ChecklistFile;
const sorted = (keys: Iterable<string>): string[] => [...keys].sort();
const union = (rows: object[]): string[] => sorted(new Set(rows.flatMap((row) => Object.keys(row))));

describe('checklist mirror', () => {
  it('fixture_parses_with_every_key', () => {
    const checklists = [file.active!, ...file.archived];
    const items = checklists.flatMap((c) => c.items);
    expect(sorted(Object.keys(file))).toEqual(sorted(FILE_KEYS));
    for (const c of checklists) expect(sorted(Object.keys(c))).toEqual(sorted(CHECKLIST_KEYS));
    expect(union(items)).toEqual(sorted(ITEM_KEYS));
    expect(union(items.flatMap((i) => i.lastDeveloperOps))).toEqual(sorted(LAST_DEVELOPER_OP_KEYS));
    expect(union(checklists.flatMap((c) => c.removed))).toEqual(sorted(REMOVED_KEYS));
    expect(union(checklists.flatMap((c) => c.recentRequests))).toEqual(sorted(RECENT_REQUEST_KEYS));
    expect(union(file.sendRecords)).toEqual(sorted(SEND_RECORD_KEYS));
    expect(union(file.pendingComplete)).toEqual(sorted(PENDING_COMPLETE_KEYS));
  });

  it('status_and_owner_sets_match', () => {
    const items = [file.active!, ...file.archived].flatMap((c) => c.items);
    expect(sorted(new Set(items.map((i) => i.status)))).toEqual(sorted(ITEM_STATUSES));
    expect(sorted(new Set(items.map((i) => i.owner)))).toEqual(sorted(ITEM_OWNERS));
    // The Rust enums serialise to exactly these strings (model.test.rs `status_and_owner_sets_exact`).
    expect([...ITEM_STATUSES]).toEqual(['upcoming', 'next', 'in_progress', 'blocked', 'complete']);
    expect([...ITEM_OWNERS]).toEqual(['agent', 'human', 'either']);
  });

  it('caps_match_rust_constants', () => {
    const rust = read('model.rs');
    const block = rust.slice(rust.indexOf('// CAPS-BEGIN'), rust.indexOf('// CAPS-END'));
    const camel = (name: string): string =>
      name.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const parsed: Record<string, number> = {};
    for (const m of block.matchAll(/^pub const ([A-Z_]+): [a-z0-9]+ = ([\d_]+);$/gm)) {
      parsed[camel(m[1]!)] = Number(m[2]!.replaceAll('_', ''));
    }
    expect(parsed).toEqual(CHECKLIST_CAPS);
  });
});
