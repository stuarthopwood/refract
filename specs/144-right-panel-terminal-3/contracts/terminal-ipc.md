# Contract: terminal IPC

Every request goes through `refract_request(channel, args)`. Replies are `Result<T>` as for every other channel. All `terminal.*` requests are refused unless the calling window label is `main` (code `terminal-refused`, FR-024). Argument 0 onward are positional JSON.

## Requests (`IPC_REQUESTS` keys, Rust `terminal/handlers.rs`)

| Channel | Args | Reply `T` | Validation and errors |
|---------|------|-----------|-----------------------|
| `terminal.list` | `sessionId` | `{ tabs: TabInfo[], activeTabId: string \| null }` | Session must exist (`terminal-not-found`). First call per Session per app run restores saved tabs as fresh shells (FR-016) |
| `terminal.create` | `sessionId`, `cols`, `rows` | `TabInfo` | `terminal-limit` at 8 tabs, message says the maximum; `terminal-not-found` |
| `terminal.attach` | `sessionId`, `tabId`, `channel` (a Tauri `Channel`, sent as its `__CHANNEL__:<id>` string), `cols`, `rows` | `{ state: TabState }` | tab must belong to the Session; channel string must parse; replaces any earlier sink for the tab; replays the ring, then streams |
| `terminal.detach` | `tabId` | `null` | idempotent |
| `terminal.input` | `tabId`, `data` (string) | `null` | `data` <= 64 KiB and per-tab <= 1 MiB/s (`terminal-rate-limited`); ignored with `terminal-not-running` if ended |
| `terminal.resize` | `tabId`, `cols`, `rows` | `null` | clamped to 1..=500 x 1..=200, never rejected for range |
| `terminal.ack` | `tabId`, `bytes` | `null` | `bytes` added to the sink's acked count; unknown tab is ignored |
| `terminal.close` | `tabId`, `force` (bool) | `{ closed: boolean, needsConfirm: boolean }` | `force=false` and a running child process -> `{ closed:false, needsConfirm:true }`, nothing killed (FR-013); otherwise kills the tree |
| `terminal.rename` | `tabId`, `name` | `TabInfo` | trimmed; empty or > 40 chars -> `invalid-argument` |
| `terminal.restart` | `tabId` | `TabInfo` | only for `ended` or `failed` tabs (`terminal-not-ended`) |
| `terminal.readOutput` | `tabId`, `mode` (`recent-command` \| `last-lines`) | `{ text: string, truncated: boolean, totalBytes: number, source: 'marker' \| 'tail' }` | ANSI stripped, capped to 32 KiB keeping the end; `recent-command` falls back to `last-lines` (200) when markers are absent, and `source` says which |

`TabInfo` = `{ id, sessionId, name, cwd, shell, order, state }`; `TabState` = `{kind:'starting'} | {kind:'running'} | {kind:'ended',code} | {kind:'failed',message}`.

New error codes added to the `IpcErrorCode` union in `src/shared/ipc.ts`: `terminal-not-found`, `terminal-limit`, `terminal-spawn-failed`, `terminal-rate-limited`, `terminal-not-running`, `terminal-not-ended`, `terminal-refused`. Messages never contain terminal content.

## Event (`IPC_EVENTS`, mirrored in `src-tauri/src/events.rs`)

`terminal:tab-state` payload `{ sessionId, tab: TabInfo }`, emitted when a tab changes state (running, ended, failed) or is renamed. It carries no output.

## Channel frames

See `data-model.md`. Tag `0x01` data, tag `0x02` exit code.

## Renderer API (`RefractApi.terminal`, `src/shared/ipc-terminal.ts`)

```ts
interface TerminalApi {
  list(sessionId: string): Promise<Result<{ tabs: TabInfo[]; activeTabId: string | null }>>
  create(sessionId: string, cols: number, rows: number): Promise<Result<TabInfo>>
  attach(sessionId: string, tabId: string, cols: number, rows: number, onFrame: (frame: ArrayBuffer) => void): Promise<Result<{ state: TabState }>>
  detach(tabId: string): Promise<Result<null>>
  input(tabId: string, data: string): Promise<Result<null>>
  resize(tabId: string, cols: number, rows: number): Promise<Result<null>>
  ack(tabId: string, bytes: number): Promise<Result<null>>
  close(tabId: string, force: boolean): Promise<Result<{ closed: boolean; needsConfirm: boolean }>>
  rename(tabId: string, name: string): Promise<Result<TabInfo>>
  restart(tabId: string): Promise<Result<TabInfo>>
  readOutput(tabId: string, mode: 'recent-command' | 'last-lines'): Promise<Result<TerminalOutput>>
  onTabState(handler: (event: { sessionId: string; tab: TabInfo }) => void): Unsubscribe
}
```

The bridge's `attach` builds the `Channel`, sets `onmessage = onFrame`, and passes the channel as an argument to `terminal.attach`. It is the only renderer file that imports `Channel`.

## Security checklist (Principle V)

- Capabilities: unchanged. No shell, process, fs or event-emit permission is added. `refract_request` stays the only app command.
- CSP: unchanged.
- Rust validates: Session exists, tab belongs to the Session (attach), window label `main`, sizes, rates, name.
- The renderer starts no process; the only spawn site is `terminal/pty.rs`.
- No terminal bytes reach any logger or error message.
