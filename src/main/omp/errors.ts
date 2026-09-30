// `chat.send`/`chat.stop` etc. map to these when the underlying condition fails, so the IPC
// layer can translate them to the matching `IpcErrorCode` (`not-idle` / `reattach-failed`).
export class SessionNotIdleError extends Error {
  readonly code = 'not-idle' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotIdleError';
  }
}

export class ReattachFailedError extends Error {
  readonly code = 'reattach-failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReattachFailedError';
  }
}

export class AgentNotRunningError extends Error {
  readonly code = 'agent-not-running' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AgentNotRunningError';
  }
}

export class PromptFailedError extends Error {
  readonly code = 'prompt-failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PromptFailedError';
  }
}
