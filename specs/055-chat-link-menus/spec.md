# Feature Specification: Chat link menus

**Feature Branch**: `chat-link-context-menus`
**Status**: Draft
**Input**: #471 "Feat: right-click context menus across the app", chat-links slice only (the "Amended and grilled 2026-10-21" block, items 1 to 6). Numbered 055. No existing spec covers it, so this is the specify route. #471 stays open (umbrella): this PR says "Part of #471".

## Clarifications

### Session 2026-10-29 (Skippy delegated by Stuart; recorded on #471)

- Q: Already shipped? A: No. `origin/main` (238dfa8a) has no `ContextMenu` or Copy control on `ExternalLink` or `FileLinkButton` in `Markdown.tsx`, and the composer has no Refract menu. #445 closed as superseded: Tauri/WebView2 shows its own native text menu (Cut, Copy, Paste, spell-check), which is not Refract's code.
- Q: Composer items (Cut, Copy, Paste, Paste as text)? A: Out of scope for this PR. The native menu already covers Cut, Copy and Paste. Paste as text needs a new clipboard-read IPC and a composer paste-handler bypass (`MessageInput.tsx`), and `src/shared/ipc.ts` is at its 902-line cap. It stays a follow-up on #471.
- Q: What does Copy path copy? A: Exactly the string passed to `sessions.revealFile` (the bare path, no `:line:col`). Accepted [proposal], item 6.
- Q: Which links? A: Web links (markdown `a`, image-alt fallback, inline-code URL) and file links (`FileLinkButton`, which also serves `ToolRow` and `DiffView`). Footnote anchors are same-page fragments: no Copy button, no menu.
- Q: How does "Open in browser" open? A: By activating the link's own anchor (`anchor.click()`), so it goes through the existing external-link policy in `src/tauri-bridge/externalLinks.ts` (http and https only, opener plugin). No new IPC and no second policy.
- Q: How does Copy write? A: The existing `CopyButton` path for the button (`navigator.clipboard`, then `window.refract.clipboard.writeText`). The menu items use a small helper with the same order and the same failure toast.
- Q: Hover-only Copy button and keyboard users? A: The button is `tabIndex={-1}`. It shows on hover and on `:focus-within` of the link. Keyboard users copy through the menu (Shift+F10 or Menu key). This overrides #524's "always visible" rule for this control only, by Stuart's decision (item 2).
- Q: Layout? A: The button reserves a small inline slot after the link so showing it never reflows the text.

## Requirements

- **FR-001** A finished web link and a finished file link (one that renders as a control) are followed by an icon-only ghost Copy button (`CopyButton`, `tabIndex={-1}`), invisible until the pointer is over the link or button, or the link has keyboard focus.
- **FR-002** The button copies the link's URL (web) or the path as passed to `revealFile` (file) and shows the shared "Copied" state and announcement.
- **FR-003** Right-click, Shift+F10 or the Menu key on a finished web link opens a themed menu (`components/ui/context-menu.tsx`) with **Copy link** and **Open in browser**.
- **FR-004** The same gesture on a finished file link opens a menu with **Copy path** and **Show in File Explorer** (the same `sessions.revealFile` call, same error toast as the click).
- **FR-005** While the owning message streams, links stay inert: no Copy button and no Refract menu.
- **FR-006** A file link that renders as plain text (no Session, or a path outside the worktree) gets neither the button nor the menu.
- **FR-007** A link nested inside another link (`InsideLinkContext`) and footnote anchors get neither.
- **FR-008** The menu does not change what a plain click does, and closing it returns focus to the link when it was focused.
- **FR-009** Nothing in this slice adds IPC, capabilities or new tests.

## Out of scope

Composer items (Cut, Copy, Paste, Paste as text), transcript-text and code-block menus, and every other #471 surface.
