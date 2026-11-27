# Analysis: Typed code snippet preview in the composer (#525)

Read-only consistency check of spec.md, plan.md and tasks.md (2026-11-27). Citations are as read on `origin/main` at `f6e941ab`.

| Check | Result |
|---|---|
| Every FR (001 to 015) has a task | Yes, see the Coverage table in tasks.md |
| Every SC (001 to 007) has a task | Yes |
| Every logic task names a co-located test | Yes (T002 to T010); T008 has none because `MessageInput.tsx` has no test on `origin/main`, the wiring is proven by T015 |
| Files named exist on `origin/main` | Verified by `git ls-files`/grep: `MessageInput.tsx` (seams at `:158`, `:264`, `:287`, `:800`), `ComposerBox.tsx` (`ComposerBox` at `:48`), `composerMarkdownMirror.tsx`, `markdownLineTokens.ts` (`FENCE` `:16`, `MAX_STYLED_DRAFT_LENGTH` `:14`), `composerIndent.ts` (`applyEdit` `:100`), `CodeBlock.tsx`, `Markdown.tsx` (`code` component `:315-362`), `FadeCollapse.tsx`, `ComposerPanel.tsx` (`COMPOSER_PANEL_MAX_HEIGHT_CLASS` `:14`), `attachments.ts` (`substituteChips` `:356`), `reducedMotion.ts` |
| New files do not collide | `lib/codeFenceLanguages.ts`, `lib/codeSnippetFence.ts`, `features/chat/useCodeFenceRewrite.ts`, `features/chat/ComposerCodePreview.tsx` and their tests are absent on `origin/main` |
| Decisions match the #525 comments | Yes: option B, strip above the textarea inside the box, no detector, fenced blocks only, one-line rule and Ctrl+Z adopted, no second overlay, spec 010 stores canonical text |

## Findings

1. **Unverified behaviour**: one native undo step from `applyEdit` after a controlled `onChange`, and `inputType: 'historyUndo'` reaching React's `onChange`, in WebView2. Not run. T001 gates T006.
2. **Unverified assumption**: the spec 050 tokenizer kinds a canonical fence body as `code` (T010 asserts it; if it does not, T010 asserts only exact concatenation).
3. **Open INFERENCES** (spec Clarifications): the curated alias table, last-block rule, announcement and 12-line cap, rewrite trigger, flag lifetime, chip handling, tilde and long fences, side chat out of scope. None is a product decision; Stuart can overrule.
4. **Correction made during analysis**: the first draft put the strip "after `AttachmentStrip`"; that component is outside `ComposerBox`. The strip is the first child of `ComposerBox` (`MessageInput.tsx:770`).
5. No contradiction between the three documents.
