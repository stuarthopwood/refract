# Implementation Plan: Composer live Markdown styling

**Spec**: [spec.md](spec.md) | **Issue**: #1170

## Approach

1. `src/renderer/lib/markdownLineTokens.ts`: pure line tokenizer (fence state across lines, line-start rules, inline code/bold/italic).
2. `src/renderer/features/chat/composerMarkdownMirror.tsx`: `ComposerMarkdownMirror`, `useComposerMarkdownSegments`, `COMPOSER_MARKDOWN_TEXTAREA_CLASS`.
3. `COMPOSER_MIRROR_CLASS` moves to `components/ComposerBox.tsx` (re-exported from `CommandPillOverlay.tsx`) so both mirrors share it without an import cycle.
4. `CommandPillOverlay.tsx`: `useCommandPillOverlay` also returns `markdownSegments` and `textareaClass`; the overlay renders the Markdown mirror when no command token shows. `MessageInput.tsx` changes three existing lines only.
5. `SideChatPanel.tsx`: hook, mirror and textarea class.
6. Docs: `docs/PLAN.md`, `CONTEXT.md`.

## File-size plan

`MessageInput.tsx` stays at 1209 (baseline): no net lines. New files are well under 600.

## Constitution check

Principle V: no capability, CSP or network change. No new dependency. No new tests (prototyping phase).

## Verification

`pnpm typecheck`, `pnpm test`, `check:file-size`; `pnpm ci:local` and a scratch-exe live check (build slot).
