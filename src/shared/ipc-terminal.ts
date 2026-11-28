// Terminal panel wire types (spec 144, contracts/terminal-ipc.md). Request and event names live in `ipc.ts`.

import type { Result, Unsubscribe } from './ipc'

export type TerminalShell = 'pwsh' | 'powershell' | 'cmd'

export type TabState =
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'ended'; code: number }
  | { kind: 'failed'; message: string }

export interface TabInfo {
  id: string
  sessionId: string
  name: string
  cwd: string
  shell: TerminalShell
  order: number
  state: TabState
}

export interface TerminalListResult {
  tabs: TabInfo[]
  activeTabId: string | null
}

export interface TerminalCloseResult {
  closed: boolean
  needsConfirm: boolean
}

export type TerminalOutputMode = 'recent-command' | 'last-lines'

/** ANSI-stripped output, capped keeping the end; `source` says whether prompt markers or the plain tail produced it. */
export interface TerminalOutput {
  text: string
  truncated: boolean
  totalBytes: number
  source: 'marker' | 'tail'
}

/** `terminal:tab-state`: a tab changed state or was renamed. Carries no output. */
export interface TerminalTabStateEvent {
  sessionId: string
  tab: TabInfo
}

/** First byte of a Channel frame: output bytes follow. */
export const FRAME_TAG_DATA = 0x01
/** First byte of a Channel frame: a little-endian i32 exit code follows. */
export const FRAME_TAG_EXIT = 0x02

export interface TerminalApi {
  list(sessionId: string): Promise<Result<TerminalListResult>>
  create(sessionId: string, cols: number, rows: number): Promise<Result<TabInfo>>
  /** Replays the tab's ring, then streams; `onFrame` gets each raw Channel frame. */
  attach(
    sessionId: string,
    tabId: string,
    cols: number,
    rows: number,
    onFrame: (frame: ArrayBuffer) => void
  ): Promise<Result<{ state: TabState }>>
  detach(tabId: string): Promise<Result<null>>
  input(tabId: string, data: string): Promise<Result<null>>
  resize(tabId: string, cols: number, rows: number): Promise<Result<null>>
  ack(tabId: string, bytes: number): Promise<Result<null>>
  close(tabId: string, force: boolean): Promise<Result<TerminalCloseResult>>
  rename(tabId: string, name: string): Promise<Result<TabInfo>>
  restart(tabId: string): Promise<Result<TabInfo>>
  readOutput(tabId: string, mode: TerminalOutputMode): Promise<Result<TerminalOutput>>
  onTabState(handler: (event: TerminalTabStateEvent) => void): Unsubscribe
}

declare module './ipc' {
  interface RefractApi {
    terminal: TerminalApi
  }
}
