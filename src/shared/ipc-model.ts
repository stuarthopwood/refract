
import type { Result } from './ipc';

/** A model offered by OMP. */
export interface Model {
  provider: string;
  id: string;
  name?: string;
}

/** Result of changing a model role. */
export interface RoleChangeSummary {
  moved: string[];
  queued: string[];
  skippedPinned: string[];
  skippedStopped: string[];
  failed: string[];
}

/** Thinking effort levels OMP accepts. */
export type ThinkingLevel = 'off' | 'inherit' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Model-related IPC surface exposed to the renderer. */
export interface ModelApi {
  setModel(sessionId: string, provider: string, modelId: string): Promise<Result<{ model: Model; queued?: boolean }>>;
  cycleModel(sessionId: string): Promise<Result<{ model: Model | null }>>;
  applyRole(
    sessionId: string,
    role: string,
  ): Promise<Result<{ model: Model | null; role: string; queued?: boolean }>>;
  listRoles(sessionId: string): Promise<
    Result<{
      roles: Array<{ role: string; model: string | null; current: boolean }>;
      currentRole: string | null;
      pinned: boolean;
    }>
  >;
  setThinkingLevel(
    sessionId: string,
    level: ThinkingLevel,
  ): Promise<Result<{ thinkingLevel: string | null; queued?: boolean }>>;
}

