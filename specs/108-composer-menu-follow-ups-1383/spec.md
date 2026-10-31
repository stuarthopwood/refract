# Spec 108: Composer context menu follow-ups (#1383)

Decisions are in the issue comment https://github.com/stuarthopwood/refract/issues/1383#issuecomment-6546427879.

## Requirements

1. A keyboard-opened context menu (Shift+F10 or the Menu key, reported as a `contextmenu` event at 0,0) anchors under the caret in a text field, or at the bottom-left corner of any other element. Done in the shared `ContextMenuTrigger` by replaying the event at the computed point (`lib/menuAnchor.ts`).
2. The spelling-replace path in `ComposerContextMenu` returns when the field is no longer focused, so `execCommand` never writes elsewhere.
3. Each text-edit item carries `aria-keyshortcuts`; the visual hint is `aria-hidden`.
4. "Paste as plain text" shows a Ctrl+Shift+V hint only if the live check proves the chord inserts the literal text.
5. The hint text meets 4.5:1 contrast on every built-in preset (no light theme ships).
6. `clipboard.writeText` failures return a fixed message; the detail goes to the log.
7. `clipboard.readText` is refused for any window other than `main`.
8. The #471 live script polls instead of sleeping and passes clipboard text through an env var.

## Ctrl+Shift+V decision

Removed. The browser's native Ctrl+Shift+V (pasteAndMatchStyle) fires a `paste` event, so `MessageInput.handlePaste` would chip a large paste, while the menu item inserts literal text. The hint and its `aria-keyshortcuts` value would advertise behaviour the key does not have. The live script still records the chord result and fails if a hint ever appears without a literal chord.

## Verification

`scripts/verify-471-composer-menu.mjs` (extended). Items 6 and 7 cannot be exercised live (no second window, no forced write failure) and are verified by code reading.
