// The `advisorRoster.*` IPC contract (#1409, spec 070): a WATCHDOG.yml roster silently replaces the
// Advisor role, so Refract detects it and warns. Refract never edits or deletes a roster.

import type { Result } from './ipc';

export interface AdvisorRosterEntry {
  name: string;
  model?: string;
}

export interface AdvisorRoster {
  /** Absolute path of the roster file OMP will read. */
  path: string;
  advisors: AdvisorRosterEntry[];
}

/** `advisor-roster:detected`: a roster was found at a Session's launch. */
export interface AdvisorRosterDetected {
  sessionId: string;
  roster: AdvisorRoster;
}

export interface AdvisorRosterApi {
  /** Searches the OMP agent dir, plus the Session's worktree up to its repo root when `sessionId` is given. */
  detect(sessionId?: string): Promise<Result<AdvisorRoster | null>>;
  /** Opens the roster file the same search finds; the renderer never supplies a path. */
  open(sessionId?: string): Promise<Result<void>>;
}

/** One-line summary shared by the Session notice and the Settings warning. */
export function describeAdvisorRoster(roster: AdvisorRoster): string {
  const count = roster.advisors.length;
  const models = [...new Set(roster.advisors.map((a) => a.model).filter((m): m is string => Boolean(m)))];
  const noun = `${count} advisor${count === 1 ? '' : 's'}`;
  return `A WATCHDOG.yml roster overrides the Advisor role: ${models.length > 0 ? `${noun} (${models.join(', ')})` : noun}.`;
}
