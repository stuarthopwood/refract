// Issue #457 quality-gate remediation (test-reviewer MEDIUM: "nothing covers migrating a
// settings.json that has no transcriptDisplay... or the IPC handler rejecting..."). This file
// covers the main-process store side (migration + per-field merge); the IPC handler's own
// shape-validation mirrors `SETTINGS_SET_READOUT_VISIBILITY`'s already-covered pattern and is a
// thin, directly-readable guard clause, not re-tested in isolation here.
//
// Scratch settings.json files are written under the OS temp directory only and left in place
// (never deleted), the same deliberate choice `terminationDetection.test.ts`/`registry.test.ts`
// already make under this project's destructive-delete guard.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from './settings';

let scratchCounter = 0;

async function openScratchStore(initialJson?: unknown): Promise<SettingsStore> {
  scratchCounter += 1;
  const dir = path.join(os.tmpdir(), `refract-settings-test-${Date.now()}-${scratchCounter}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  if (initialJson !== undefined) {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(initialJson), 'utf8');
  }
  return SettingsStore.open(dir);
}

describe('SettingsStore transcriptDisplay migration', () => {
  it('defaults to { thinking: true, toolCalls: true } on a brand-new settings.json', async () => {
    const store = await openScratchStore();
    expect(store.get().transcriptDisplay).toEqual({ thinking: true, toolCalls: true });
  });

  it('fills in the default when an existing settings.json has no transcriptDisplay key at all', async () => {
    const store = await openScratchStore({ version: 1, approvalMode: 'ask', sessionReadout: {}, split: null, theme: 'dark', watermarkEnabled: true });
    expect(store.get().transcriptDisplay).toEqual({ thinking: true, toolCalls: true });
  });

  it('falls back to the default when transcriptDisplay is a malformed shape', async () => {
    for (const malformed of [5, 'yes', [], { thinking: 'yes' }, { thinking: true }, null]) {
      const store = await openScratchStore({
        version: 1,
        approvalMode: 'ask',
        sessionReadout: {},
        split: null,
        theme: 'dark',
        watermarkEnabled: true,
        transcriptDisplay: malformed,
      });
      expect(store.get().transcriptDisplay).toEqual({ thinking: true, toolCalls: true });
    }
  });
});

describe('SettingsStore.setTranscriptDisplay', () => {
  it('merges one field without touching the other (quality-gate HIGH: a quick second toggle must not revert the first)', async () => {
    const store = await openScratchStore();
    await store.setTranscriptDisplay('thinking', false);
    const afterFirst = await store.setTranscriptDisplay('toolCalls', false);
    expect(afterFirst.transcriptDisplay).toEqual({ thinking: false, toolCalls: false });
  });

  it('setting the same field twice is idempotent and never affects the other field', async () => {
    const store = await openScratchStore();
    await store.setTranscriptDisplay('toolCalls', false);
    const result = await store.setTranscriptDisplay('toolCalls', false);
    expect(result.transcriptDisplay).toEqual({ thinking: true, toolCalls: false });
  });

  it('persists across a reopen of the same settings directory', async () => {
    scratchCounter += 1;
    const dir = path.join(os.tmpdir(), `refract-settings-test-${Date.now()}-${scratchCounter}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    const first = await SettingsStore.open(dir);
    await first.setTranscriptDisplay('thinking', false);
    const reopened = await SettingsStore.open(dir);
    expect(reopened.get().transcriptDisplay).toEqual({ thinking: false, toolCalls: true });
  });
});
