# Plan: Chat link menus

## Approach

- New `src/renderer/features/chat/LinkActions.tsx` (keeps `Markdown.tsx` near its cap): `LinkActions` wraps a link in `<span class="group/link">` with `ContextMenu` + `ContextMenuTrigger asChild`, the link, and a `CopyButton` (`tabIndex={-1}`, opacity 0, shown by `group-hover/link` and `group-focus-within/link`). Takes `copyText`, `copyLabel`, `announcement`, and `items: { label, onSelect }[]`.
- New `src/renderer/features/chat/linkClipboard.ts`: `copyLinkText(text)` (`navigator.clipboard`, fall back to `window.refract.clipboard.writeText`, `notify` on failure, `toast.success` on success).
- `Markdown.tsx`: `ExternalLink` takes an anchor ref and wraps in `LinkActions` with Copy link / Open in browser (`anchor.click()`); `FileLinkButton`'s active branch wraps in `LinkActions` with Copy path / Show in File Explorer, reusing one `reveal()` for click and menu. Inert, plain-text and nested branches are untouched.
- Radix `ContextMenu` opens on the `contextmenu` event, which WebView2 also fires for Shift+F10 and the Menu key on the focused link. Radix returns focus to the (unfocusable) trigger span, so `LinkActions` records the focused element on open and restores it in `onCloseAutoFocus`.

## Files

`LinkActions.tsx` (new), `linkClipboard.ts` (new), `Markdown.tsx`, `docs/PLAN.md`, `specs/055-chat-link-menus/*`.

## Analysis (cross-check)

- Every FR maps to a task; FR-005 to FR-007 are satisfied by not touching the inert, plain-text and nested branches.
- No IPC change, so `ipc.ts` (at cap) and the capability files are untouched.
- Risk: `ContextMenuTrigger` adds `select-none`; override with `select-text` so link text stays selectable.
- Risk: the link's tooltip and the Copy button's tooltip are separate triggers and may both show; accepted.
