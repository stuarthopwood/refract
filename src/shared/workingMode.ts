import type { Result } from './ipc';

/** A Session's working mode; Approval mode is separate and app-wide. */
export type WorkingMode = 'interactive' | 'plan' | 'grill' | 'away';

export const WORKING_MODES: readonly WorkingMode[] = ['interactive', 'plan', 'grill', 'away'];

/** Working-mode IPC surface exposed to the renderer. */
export interface WorkingModeApi {
  set(sessionId: string, mode: WorkingMode): Promise<Result<{ mode: WorkingMode; pending?: boolean }>>;
}
