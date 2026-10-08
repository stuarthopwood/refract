// Low-memory monitor (tasks.md T039, FR-037): samples `os.freemem()` every 5 s and pushes
// `memory:warning` only when the low/not-low state changes, plus once a minute while it stays
// low (so the status bar can re-surface the warning without main spamming on every sample).
// Never stops an agent automatically; that stays the user's call (Stop agent, T040).

import os from 'node:os';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../shared/ipc';
import type { SessionManager } from './SessionManager';

const SAMPLE_INTERVAL_MS = 5_000;
// Exported so other start-cost-sensitive callers (issue #512 requirement 5's start-queue
// memory defer, `src/main/omp/OmpProcess.ts`) reuse this exact threshold instead of a second,
// possibly-drifting definition.
export const LOW_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const REPEAT_WHILE_LOW_MS = 60_000;

/** Issue #512 requirement 5: a cheap synchronous check a start-queue gate can call before
 * spawning an `omp` process, reusing the same threshold as the monitor above. */
export function isMemoryLow(): boolean {
  return os.freemem() < LOW_MEMORY_BYTES;
}

export function startMemoryMonitor(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  let lastLow: boolean | undefined;
  let lastEmitAt = 0;

  setInterval(() => {
    const freeBytes = os.freemem();
    const low = freeBytes < LOW_MEMORY_BYTES;
    const now = Date.now();
    const changed = low !== lastLow;
    const dueRepeat = low && now - lastEmitAt >= REPEAT_WHILE_LOW_MS;
    if (!changed && !dueRepeat) return;
    lastLow = low;
    lastEmitAt = now;

    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC_EVENTS.MEMORY_WARNING, { low, freeBytes, liveAgents: manager.liveAgentCount() });
  }, SAMPLE_INTERVAL_MS);
}
