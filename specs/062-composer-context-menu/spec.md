# Feature Specification: Composer context menu

**Feature Branch**: `context-menus-471`
**Status**: Draft
**Input**: #471 "Feat: right-click context menus across the app", composer slice. The chat-links slice shipped in spec 055 (PR #1350), so Step 0 found that part done. Numbered 062; no existing spec covers the composer menu, so this is the specify route. #471 stays open (umbrella): the PR says "Refs #471".

## Clarifications

### Session 2026-10-30 (Skippy delegated by Stuart; recorded here, nothing asked)

- Q: Already shipped? A: Chat links (Copy link, Open link, Copy path, Show in File Explorer) are on `origin/main` (3e1b8051, spec 055). The composer has no Refract menu; WebView2's native text menu shows instead.
- Q: Which component? A: The existing themed `components/ui/context-menu.tsx` (Radix ContextMenu, already a dependency). The menu lives in the shared `ComposerTextarea` (ADR 0003), so the main composer and the side chat both get it. No new dependency.
- Q: Items? A: Cut, Copy, Paste, Paste as plain text, separator, Select all.
- Q: Disabled states? A: Cut and Copy need a non-empty selection; Cut, Paste and Paste as plain text need an editable field; Select all needs non-empty text. State is read when the menu opens.
- Q: Where does Paste read from? A: The sandboxed renderer may refuse `navigator.clipboard.readText`, so a minimal `clipboard.readText` IPC (Rust `clipboard().read_text()`, no webview permission) returns the text. No new capability: Rust-side plugin calls need none (Constitution Principle V).
- Q: How does Paste differ from Paste as plain text? A: Paste replays the text as a synthetic `paste` event, so the composer's own handler runs (large-text chip collapse, image-path detection). Paste as plain text inserts the literal text and bypasses that handler. Clipboard images and files are not reachable from the menu (text only).
- Q: Keyboard? A: Shift+F10 and the Menu key fire `contextmenu` on the textarea, which Radix opens. Arrow keys, Esc and typeahead are Radix's. Closing returns focus to the textarea, where the chosen action then runs, so native undo stays intact.

## Requirements

- **FR-001** Right-click, Shift+F10 or the Menu key in the composer text field opens the themed menu with Cut, Copy, Paste, Paste as plain text, Select all.
- **FR-002** Cut and Copy are disabled with no selection; Cut, Paste and Paste as plain text are disabled when the field is read-only or disabled; Select all is disabled when the field is empty.
- **FR-003** Cut and Copy put exactly the selected text on the clipboard (renderer first, then `clipboard.writeText`); Cut also removes it as an undoable edit.
- **FR-004** Paste inserts the clipboard text at the caret, replacing the selection, through the composer paste handler. Paste as plain text inserts it verbatim, bypassing that handler.
- **FR-005** An empty or unreadable clipboard shows a failure notice and changes nothing.
- **FR-006** Closing the menu returns focus to the field with the selection intact.
- **FR-007** The new IPC is `clipboard.readText` only, returns the clipboard text, and adds no capability.

## Out of scope (follow-ups on #471)

Spell-check suggestions, clipboard image and file paste from the menu, transcript text, code-block, tab, terminal, explorer and git-changes menus, and Undo/Redo items.
