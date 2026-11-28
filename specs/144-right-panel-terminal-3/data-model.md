# Data model: Right-panel terminal

Feature: `specs/144-right-panel-terminal-3/spec.md`.

## Constants (`src/shared/terminalLimits.ts`, mirrored in Rust `terminal/limits.rs`; a parity test compares the two)

| Name | Value | Source |
|------|-------|--------|
| `MAX_TABS_PER_SESSION` | 8 | FR-009 (INFERENCE: the figure) |
| `SCROLLBACK_BYTES` | 2 097 152 | FR-010 (INFERENCE: the figure) |
| `ASK_FALLBACK_LINES` | 200 | FR-020 (INFERENCE: the figure) |
| `OUTPUT_CAP_BYTES` | 32 768 | FR-021 (INFERENCE: the figure) |
| `NAME_MAX_CHARS` | 40 | tab name |
| `INPUT_MAX_BYTES` | 65 536 | per `terminal.input` call, FR-024 |
| `INPUT_RATE_BYTES_PER_SEC` | 1 048 576 | per tab, FR-024 |
| `COLS` range | 1..=500 | resize |
| `ROWS` range | 1..=200 | resize |
| `ACK_EVERY_BYTES` | 131 072 | renderer acks |
| `UNACKED_PAUSE_BYTES` | 524 288 | reader pauses above |

## Terminal tab (Rust, `terminal/tab.rs`; in memory)

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID v4 string | issued by Rust; the renderer never invents one |
| `session_id` | string | must exist in the registry |
| `name` | string | 1..=40 chars after trim; default `Terminal N` (lowest unused N) |
| `cwd` | path | resolved at start; saved |
| `shell` | `pwsh` \| `powershell` \| `cmd` | saved |
| `order` | u32 | position in the strip; saved |
| `state` | `starting` \| `running` \| `ended { code }` \| `failed { message }` | not saved |
| `pid` | u32 option | shell root pid while running |
| `size` | (cols, rows) | last resize |
| `ring` | `Ring` | see below; never saved |
| `sink` | option of channel + `unacked` counter | present only while attached |
| `markers` | up to 64 absolute offsets | OSC 133 `A`; PowerShell shells only |

State transitions: `starting` -> `running` -> `ended`; `starting` -> `failed`; `ended` or `failed` -> `starting` on `terminal.restart` (same id, empty ring, same name/cwd/order). Closing removes the tab.

## Ring (`terminal/ring.rs`)

Fixed-capacity byte buffer of `SCROLLBACK_BYTES`. Tracks `total_written: u64` (absolute offset of the next byte) and `start: u64` (absolute offset of the oldest retained byte). `push(&[u8])` drops oldest bytes, then advances `start` to just after the next `\n` when the cut left a partial line (unless the retained data is one line). `snapshot() -> Vec<u8>` and `tail_lines(n)`. Invariants: `len <= capacity`; `total_written - start == len`; markers with offset `< start` are discarded.

## Saved tab record (`<data_dir>/terminal_tabs.json`; the only persisted data, FR-011/FR-016)

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "activeTabId": "<tabId>",
      "tabs": [ { "id": "<tabId>", "name": "Terminal 1", "cwd": "C:\\repo", "shell": "pwsh", "order": 0 } ]
    }
  }
}
```

No output, input, title text from the shell, pid or environment. Parsed defensively (`atomic_json::read_json_file` quarantines a corrupt file): unknown shell kinds become `powershell`; more than 8 tabs are truncated; names are trimmed and clamped; entries for unknown Session ids are dropped at load and when a Session is deleted.

## Renderer state (`state/terminal-store.ts`, zustand; nothing here is persisted)

```ts
interface TerminalTab { id: string; name: string; cwd: string; shell: 'pwsh' | 'powershell' | 'cmd'; order: number; state: TabState }
type TabState = { kind: 'starting' } | { kind: 'running' } | { kind: 'ended'; code: number } | { kind: 'failed'; message: string }
interface TerminalStoreState { bySession: Record<string, { tabs: TerminalTab[]; activeTabId: string | null; loaded: boolean }> }
```

Fed by `terminal.list` and the `terminal:tab-state` event. The store holds no output.

## Channel frames (Rust -> renderer, binary; first byte is the tag)

| Tag | Payload | Meaning |
|-----|---------|---------|
| `0x01` | bytes | output (replay first, then live) |
| `0x02` | i32 little-endian | the shell ended with this exit code |

## Wire types (`src/shared/ipc-terminal.ts`)

See `contracts/terminal-ipc.md`.
