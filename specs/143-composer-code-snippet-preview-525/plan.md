# Implementation Plan: Typed code snippet preview in the composer (#525)

**Branch**: `feat/composer-code-snippets-525` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)
**Input**: spec 143 (clarified). Builds on [spec 050](../050-composer-markdown-styling/plan.md) and [spec 010](../010-composer-draft-persistence/spec.md). [ADR 0003](../../docs/adr/0003-reusable-ui-components-only.md).

## Summary

Pure logic in `src/renderer/lib/` decides what a draft's fences are: a curated language table, a rewrite edit for a just-closed one-line block, a send-time normaliser and a "last fenced block" finder. A hook `useCodeFenceRewrite` applies the rewrite through `applyEdit` (so Ctrl+Z is native undo) and tracks the undo opt-out. A small component `ComposerCodePreview` composes the shared `CodeBlock`, `FadeCollapse` and the `ComposerPanel` height cap and is mounted inside `ComposerBox` above the field. `handleSend` normalises before `substituteChips`. No new dependency, no new overlay, no backend change, bubble rendering unchanged.

## Dependencies (explicit)

| Needs | From what exactly | Checked by |
|---|---|---|
| One native undo step per rewrite | `applyEdit` in `features/chat/composerIndent.ts:100` (`document.execCommand`) | T001 (probe) |
| `inputType` on the textarea change | the React `onChange` event's `nativeEvent` in `MessageInput.tsx` (textarea at `:787`, `onChange` at `:800`) | T001 |
| Highlighted, escaped code rendering | `CodeBlock` (`features/chat/CodeBlock.tsx`, props `embedded`, `streaming`, `lang`, `code`), lazy shiki via `shikiHighlighter.ts` | T007 |
| Reduced-motion collapse | `components/FadeCollapse.tsx`, `lib/reducedMotion.ts` | T007 |
| Preview height cap | `COMPOSER_PANEL_MAX_HEIGHT_CLASS` in `components/ComposerPanel.tsx:14` | T007 |
| Fence parse that matches spec 050 | `FENCE` in `lib/markdownLineTokens.ts:16`, `MAX_STYLED_DRAFT_LENGTH` (`:14`) | T003, T005 |
| Draft stays canonical text | `state/draft-store.ts`, `substituteChips` in `features/chat/attachments.ts:356` | T008 |
| Bubble renders the fence | `features/chat/Markdown.tsx:315-362` (`code` component to `CodeBlock`) | T009 |

## Design

### Pure logic (`src/renderer/lib`)

1. `codeFenceLanguages.ts`: `FENCE_LANGUAGES` (alias list to `{ id, label }`, for example `ts` to `{ id: 'ts', label: 'TypeScript' }`), `resolveFenceTag(word)` case-insensitive, returns `null` when unknown. The tag written into the draft is the lowercase alias the user typed; shiki resolves aliases itself.
2. `codeSnippetFence.ts`:
   - `findFenceRewrite(text, caret): ComposerEdit | null` for FR-001, FR-002, FR-005 (open-fence and slash guards).
   - `normaliseFencesForSend(text): string` for FR-012, scanning line by line with the same CommonMark open/close logic as `markdownLineTokens.ts` so canonical fences are skipped.
   - `findPreviewBlock(text): { lang: string | null; label: string | null; code: string; lineCount: number } | null` for FR-006, FR-007 (last block, open or closed).
   - `describeSnippetAnnouncement(block): string` for FR-009.

### Hook and component (`src/renderer/features/chat`)

3. `useCodeFenceRewrite.ts`: `useCodeFenceRewrite({ textareaRef, text, disabled })` returns `{ onInput(event), literalBackticks, resetLiteral }`. It remembers the last input type, and after commit (layout effect) calls `findFenceRewrite` and `applyEdit` when the last input was `insertText` or `insertFromPaste` and not composing. On `historyUndo` immediately after a rewrite it sets `literalBackticks`. The decision (`shouldRewrite(inputType, isComposing, literal, text)`) is a pure exported function so it is unit tested without a DOM (the repo has no jsdom, `vitest.config.ts:14`).
4. `ComposerCodePreview.tsx`: wraps `CodeBlock` (`embedded`, `streaming`) in `FadeCollapse`; wrapper `aria-hidden` and `inert`, capped by `COMPOSER_PANEL_MAX_HEIGHT_CLASS`, shows 12 lines and "N more lines"; reads `useDeferredValue(block.code)`; renders the sr-only `role="status"` line, updated only when `describeSnippetAnnouncement` changes. Props: `{ text: string; enabled: boolean }`. It takes no overlay slot.
5. `MessageInput.tsx` (net at most 12 lines): call the hook beside `useCommandPillOverlay` (`:158`), pass `onInput` through the existing `onChange` (`:800`), mount `<ComposerCodePreview text={text} enabled={...} />` as the first child of `<ComposerBox>` (`:770`), before `<ComposerField>` (`:771`; `ComposerBox` is a `flex flex-col` that already takes children, so `ComposerBox.tsx` is unchanged and the side chat is unaffected), and in `handleSend` (`:287`) call `normaliseFencesForSend` before `substituteChips` unless `literalBackticks`; reset the flag where the draft clears on send.

### Spec 050 and 010

- The spec 050 tokenizer already treats a line starting with three backticks as a fence opener, so a canonical fence is styled as `code` by the mirror (`composerMarkdownMirror.tsx`); the transient one-line form lives for one input event. T010 pins this with a test.
- The draft store receives the rewritten text through the normal change path; its shape is untouched (spec 010 FR-004, FR-007).

## File-size plan

`MessageInput.tsx` is 906 lines with a baseline of 1209 (`scripts/file-size-baseline.json:6`): at most 12 net lines, baseline not raised. New files each stay under 250 lines (cap 600).

## Constitution check

Principle V (Tauri security baseline): no capability, CSP or network change; code reaches only `CodeBlock`'s escaped path (FR-014). No new dependency. Testing V1: every task with logic names a co-located test; the repo has no jsdom, so component tests are `renderToStaticMarkup` string assertions as in `CodeBlock.test.ts`, and the live behaviour is proven in T015.

## Risks

- Whether `execCommand` in a layout effect after a controlled `onChange` yields a single undo step and whether `inputType` survives React's synthetic event: unproven (P1, T001). T006 does not start until it passes; the fallback is a keydown handler restoring a stored snapshot.
- The literal-backticks flag is lost on a Session switch (spec 010 keeps the draft shape): accepted, documented.
- A user typing a code block that legitimately contains a one-line fence in prose could be rewritten once; Ctrl+Z is the stated recovery.
- `MessageInput.tsx` is near-central; mount edits are kept to the three existing seams to avoid conflicts with the composer lanes (#1865 modes).

## Complexity

No constitution violation. New files: `lib/codeFenceLanguages.ts`, `lib/codeSnippetFence.ts`, `features/chat/useCodeFenceRewrite.ts`, `features/chat/ComposerCodePreview.tsx`, each with a co-located test.
