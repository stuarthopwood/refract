# Data model: Tool-row icons with verb tooltips

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

No new storage. Three things change shape: the verb map entry (renderer only), the transcript tool item (Rust and TypeScript, crosses IPC), and the transcript display settings (Rust and TypeScript, persisted).

## Tool display entry (renderer, `src/renderer/features/chat/toolVerbs.ts`)

One entry per tool in the frozen `TOOL_VERBS` record; the only map (FR-002).

| Field | Type | Rule |
|---|---|---|
| `icon` | lucide-react component | Required for every tool entry; absent for `thinking`. Values in FR-003. |
| `running` | string | Sentence case, used while `status === 'running'`. |
| `done` | string | Used when `status === 'done'`. |
| `base` | string | Used for `error`, `interrupted`, `cancelled`, `exited`. Absent for `thinking` (falls back to `done`). |

Keys (FR-003): `read`, `edit`, `write`, `bash`, `eval`, `grep`, `find`, `glob` (same object as `find`), `ast_grep`, `ast_edit`, `lsp`, `task`, `ask`, `web_search`, `github`, `debug`, `recall`, `retain`, `reflect`, `generate_image`, `wait`, `skill`, `thinking`.

Lookup: `Object.hasOwn(TOOL_VERBS, tool)`. No entry: label is `sentenceCaseToolName(tool)` in every status; icon is Wrench (or Plug for `mcp__`).

## Resolved tool display (renderer, `src/renderer/features/chat/toolDisplay.ts`)

Derived per row, never stored.

| Field | Type | Rule |
|---|---|---|
| `key` | string | Grouping key. Tool id, or `xd:<x>` for a `write` to `xd://<x>`. |
| `entryTool` | string | The tool whose entry supplies icon and verbs: the tool id, or `<x>` for an `xd://` write. |
| `icon` | lucide-react component | Entry icon; Plug for `mcp__*`; Wrench when unmapped. |
| `rawId` | string | Tooltip and setting-on text: the tool id, or `write xd://<x>`. |

Label rule (FR-007): non-empty `intent`, otherwise `toolVerb(entryTool, status)`; for `mcp__<name>`, `sentenceCaseToolName(<name>)`, with "Tool" for an empty name.

## Transcript tool item: `intent` (crosses IPC)

| Side | Location | Field |
|---|---|---|
| Rust | `src-tauri/src/omp/transcript.rs:84` `TranscriptItem::Tool` | `#[serde(default, skip_serializing_if = "Option::is_none")] intent: Option<String>` |
| TypeScript | `src/shared/model.ts` tool item (about `:417-451`) | `intent?: string` |

Validation (FR-008, FR-009; `tool_intent.rs`):

- Source order. Live: `frame.intent`, `frame.args.i`, `frame.args.intent`. History and snapshot: `arguments.i`, `arguments.intent`.
- Only string values count; any other JSON type is absent.
- Remove C0 and C1 control characters and U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069; collapse whitespace runs to one space; trim; cap at 400 characters.
- Empty after cleaning: `None`.

State transitions:

| Event | Intent before | Intent after |
|---|---|---|
| `tool_execution_start` creates the item | none | live value or `None` |
| history or snapshot `toolCall` creates the item | none | history value or `None` |
| snapshot or history merges into an existing item | `Some(a)` | the new value if `Some`, else `Some(a)` |
| `tool_execution_end` or a tool result | any | unchanged |

Every other `TranscriptItem::Tool` construction (result-only items at `transcript.rs:1271` and `:1504`, `omp/diff.rs:150`, test literals) sets `intent: None`.

## Transcript display settings: `toolNames` (persisted)

| Side | Location | Field |
|---|---|---|
| TypeScript | `src/shared/transcriptDisplay.ts` `TranscriptDisplaySettings` | `toolNames: boolean`; `DEFAULT_TRANSCRIPT_DISPLAY.toolNames = false` |
| Rust | `src-tauri/src/store/settings.rs:67` | `#[serde(rename = "toolNames", default)] tool_names: bool` (default `false`) |
| Rust setter | `store/settings.rs` (about `:471-482`) and `ipc/settings.rs:308-311` | field `"toolNames"` accepted alongside `"thinking"` and `"toolCalls"` |

Rules: off by default (FR-012); a settings file without the key reads as `false`; applied immediately through the existing `setTranscriptDisplay(field, visible)` call with no new channel; persisted with the other transcript display fields.
