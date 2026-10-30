# Plan: 065 transcript menus

## Approach

- Extract `CodeBlock` and `MermaidBlock` from `Markdown.tsx` (baselined over cap; must not grow) into `CodeBlock.tsx`, `MermaidBlock.tsx` and `mermaidImage.ts`.
- Register actions `transcript.copyMessage`, `copyMessagePlain`, `scrollToPrompt`, `copyCode`, `toggleWrap`, `toggleExpand`, `copyToolCommand`, `copyToolOutput`, `mermaid.copySource`, `mermaid.copyImage`, `mermaid.saveImage` with icons in the registry; menus use `actionMenuItem`.
- A shared `TranscriptContextMenu` wraps surfaces (modelled on `LinkActions.tsx`), uses `useExclusiveMenu`, refocuses the opener on close, and adds Copy selection first when `getSelection()` is non-empty.
- `MessageActions` renders the reserved `h-6` row with the ghost `CopyButton` for finished messages.
- Plain text: a small Markdown stripper in `features/chat/markdownPlainText.ts`.
- Mermaid image: rasterise the SVG to a canvas at 2x with the theme background; PNG as base64.
- New IPC: `clipboard.writeImage` (PNG base64, size-capped, decoded with the `png` crate) and `dialog.saveImage` (blocking save dialog under `spawn_blocking`). Wire `src/shared`, `tauri-bridge`, Rust handlers, `check-parity` lane entries.
- Live check: `scripts/verify-065-transcript-menus.mjs`.

## Risks

Markdown.tsx size baseline; WebView2 native menu precedence (handled by Radix trigger claiming the event); canvas taint from SVG data URLs (use data URL, no external refs).
