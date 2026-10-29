// Pause mode (#477, spec 056): the per-Session pause state carried on status events, the session
// list and the runtime view, plus the `chat.pause*` API. Kept out of ipc.ts and model.ts, which
// are at their file-size caps.

import type { Result } from './ipc';

/** `pausing`: Paused was requested while a turn runs; `paused`: no turn is running. Absent means
 * the Session is not paused. */
export type PauseState = 'pausing' | 'paused';

// Module augmentation: the three wire shapes gain an optional `pause`.
declare module './ipc' {
  interface SessionSummary { pause?: PauseState }
  interface SessionRuntimeView { pause?: PauseState }
  interface SessionStatusEvent { pause?: PauseState }
}

export interface ChatPauseApi {
  /** Pauses after the running turn finishes; queued and new messages are held until resume. */
  pause(sessionId: string): Promise<Result<void>>;
  resume(sessionId: string): Promise<Result<void>>;
  pauseAll(): Promise<Result<{ count: number }>>;
  resumeAll(): Promise<Result<{ count: number; failed: number }>>;
}
