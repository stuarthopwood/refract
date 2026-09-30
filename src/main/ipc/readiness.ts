// IPC handler for `readiness.*` (contracts/ipc.md "Readiness"): delegates to the real checks in
// `../readiness.ts` (tasks.md T020).

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Readiness, Result } from '../../shared/ipc';
import { readinessCheck } from '../readiness';

export function registerReadiness(): void {
  ipcMain.handle(IPC_REQUESTS.READINESS_CHECK, async (): Promise<Result<Readiness>> => ({ ok: true, value: await readinessCheck() }));
}
