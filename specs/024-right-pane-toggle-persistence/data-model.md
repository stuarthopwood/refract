# Data model

`Settings.rightPane` (Rust `RightPaneState`, camelCase on the wire):

| Field | Type | Default | Rule |
|---|---|---|---|
| `open` | boolean | `false` | non-boolean resets to default |
| `widthPx` | integer | `320` | clamped 240 to 520 (superseded by 137: the 520 cap is gone, the clamp is 240 to 4096) |
| `openPanelIds` | string[] | `[]` | de-duplicated, max 16 ids, each max 64 bytes; unknown ids dropped by the renderer on restore |
| `activePanelId` | string or null | `null` | must be in `openPanelIds`, else repaired to the last tab |

A missing or null key is the default (no migration). A malformed object resets to the default. Single writer: `right-pane-persistence.ts`; the renderer never reads a broadcast back.
