# Tasks: Typed code snippet preview in the composer (#525)

Each task is for a fresh, narrow worker. Constraints for all: Testing V1 (a co-located unit test for every new or changed logic; prove each guard by mutation: remove the guard, watch the test fail, restore); why-only comments; files under 600 lines; no new dependency; no builds or tests mid-task except the task's own named test. The repo has no jsdom (`vitest.config.ts:14`, `environment: 'node'`): component tests render to a string with `renderToStaticMarkup` as `CodeBlock.test.ts` does. Reuse `CodeBlock`, `FadeCollapse`, `COMPOSER_PANEL_MAX_HEIGHT_CLASS` and `applyEdit`; no new one-off control (ADR 0003). Every citation is verified on `origin/main` at `f6e941ab`; a file a task creates is marked "new".

## Phase 0: Probe (gate)

- [ ] T001 Probe P1 (FR-003, FR-004). Touches no source file. In a scratch debug build (isolated data and WebView2 profile, `skill://refract-tauri-live-check-isolation`) drive the real composer textarea through the CDP: type text, call `applyEdit` (`features/chat/composerIndent.ts:100`) from an `input` event, then Ctrl+Z. Record in spec.md Clarifications ("P1 result"): is it one undo step, does the controlled `onChange` receive `nativeEvent.inputType === 'historyUndo'`, does `insertFromPaste` carry through. Gates T006. If it fails, spec FR-004 and plan Design item 3 are amended to the snapshot-restore keydown handler before T006 starts.

## Phase 1: Pure logic (touches no DOM; does not wait for T001)

- [ ] T002 (FR-001, FR-009, SC-001) `src/renderer/lib/codeFenceLanguages.ts` (new): `FENCE_LANGUAGES`, `resolveFenceTag(word)` (case-insensitive; `null` when unknown), `languageLabel(tag)` for the announcement and header. Test `src/renderer/lib/codeFenceLanguages.test.ts` (new): every alias in upper and lower case resolves, `go`, `c`, `is`, `hello` handling per the Clarifications INFERENCE (a prose word never becomes a tag), unknown returns `null`.
- [ ] T003 (FR-001, FR-002, FR-005, SC-001) `src/renderer/lib/codeSnippetFence.ts` (new): `findFenceRewrite(text, caret)` returning a `ComposerEdit`. Test `src/renderer/lib/codeSnippetFence.test.ts` (new): the three #525 examples; `hello world`; newline after the language; text before and after the block; caret not at a closing triple; a triple inside an open canonical fence; draft starting with `/`; draft over `MAX_STYLED_DRAFT_LENGTH`; four backticks and `~~~` untouched; the returned `selStart` and `selEnd` land after the closing fence.
- [ ] T004 (FR-006, FR-007, FR-009) same file: `findPreviewBlock(text)` (last fenced block, open or closed, tag, body, line count) and `describeSnippetAnnouncement(block)`. Tests in `codeSnippetFence.test.ts`: several blocks, an unclosed fence, a tilde fence, no fence returns `null`, an unknown tag announces "text", line count of one and many, the string is equal for two bodies of equal language and line count only when line count is equal (so the announcement changes with language or presence per FR-009; a line-count change is allowed to change it: record the chosen behaviour in the test).
- [ ] T005 (FR-012, SC-003) same file: `normaliseFencesForSend(text)`. Tests in `codeSnippetFence.test.ts`: fence-free text byte-identical; a canonical block untouched; a one-line block anywhere in the text becomes three parts; idempotence on a set of inputs including CRLF; a one-line fence inside a canonical fence is untouched; backticks in prose without a closing triple are untouched.

## Phase 2: Hook, component, wiring

- [ ] T006 (FR-003, FR-004, FR-005, SC-002; gated by T001) `src/renderer/features/chat/useCodeFenceRewrite.ts` (new): the exported pure `shouldRewrite(inputType, isComposing, literal, text)`, and the hook that applies `findFenceRewrite` through `applyEdit` after an `insertText` or `insertFromPaste` input and sets the literal-backticks flag on a `historyUndo` that follows a rewrite. Test `useCodeFenceRewrite.test.ts` (new): `shouldRewrite` truth table (`historyUndo`, `historyRedo`, composing, literal flag set, slash draft, disabled, insert types); the flag is set only by an undo directly after a rewrite and cleared by send or an empty draft (reducer-style helper tested directly).
- [ ] T007 (FR-006 to FR-011, SC-005) `src/renderer/features/chat/ComposerCodePreview.tsx` (new): `{ text, enabled }`; wraps `CodeBlock` (`embedded`, `streaming`) in `FadeCollapse`, `aria-hidden` and `inert`, height cap `COMPOSER_PANEL_MAX_HEIGHT_CLASS` (`components/ComposerPanel.tsx:14`), 12 lines then "N more lines", `useDeferredValue` on the code, an sr-only `role="status" aria-live="polite"` line. Test `ComposerCodePreview.test.ts` (new, `renderToStaticMarkup`, `vi.mock('@/state', ...)` as in `CodeBlock.test.ts`): nothing rendered but the empty status region when there is no fence or `enabled` is false; `aria-hidden` and `inert` present; no `button`, `a`, `input` or `tabindex` in the markup; the 12-line cap and the "N more lines" label; the announcement text; header shows "text" for an unknown tag.
- [ ] T008 (FR-003, FR-004, FR-012, FR-013) `src/renderer/features/chat/MessageInput.tsx`: three seams only, at most 12 net lines, baseline in `scripts/file-size-baseline.json` not raised. Call the hook beside `useCommandPillOverlay` (`:158`); pass the input type from the textarea `onChange` (`:800`); mount `<ComposerCodePreview />` as the first child of `<ComposerBox>` (`:770`); call `normaliseFencesForSend` before `substituteChips` (`:287`) unless the literal flag is set; clear the flag beside the existing `useDraftStore.getState().clear(sessionId)` calls (`:264`, `:312`, `:335`, `:378`). Test: the send-path ordering and the flag skip are covered by T005 and T006 helpers; add a case to `MessageInput`'s nearest existing test only if one exists (none on `origin/main`: record that in the PR, the live check T015 covers the wiring).
- [ ] T009 (FR-015, SC-004) `src/renderer/features/chat/Markdown.test.ts`: a normalised three-part fence renders through `CodeBlock` with the language header, and a `hello world` block with the "text" header. No source change.
- [ ] T010 (FR-013) spec 050 coexistence. Test `src/renderer/lib/markdownLineTokens.test.ts` (new: `origin/main` has no test for `lib/markdownLineTokens.ts` or `features/chat/composerMarkdownMirror.tsx`): a canonical fence the rewrite produces tokenizes with the segments' concatenation exactly equal to the draft and the body kinded `code`, so the mirror styles it and draws no extra overlay; `composerMarkdownSegments` returns `null` for a draft starting with `/`. No source change.

## Phase 3: Polish and gate

- [ ] T011 `CONTEXT.md` (glossary only): "Code snippet preview" and "Literal backticks flag". No `docs/PLAN.md` edit (the controller owns it).
- [ ] T012 `pnpm typecheck`, `pnpm test`, `pnpm check:file-size`, `pnpm check:theme-contrast`, `pnpm check:indent` (SC-006).
- [ ] T013 Review gate (code-reviewer, test-reviewer, security-auditor, accessibility-auditor, ui-architect-v3) on the diff; fix findings.
- [ ] T014 Build slot, merge `origin/main`, `pnpm ci:local`.
- [ ] T015 Live check (SC-007) in a scratch debug build per `skill://verify-refract-tauri-build-live`: type the three #525 examples, Ctrl+Z, send, switch Session and back (spec 010), toggle Reduce motion, screen-reader tree shows one status line and no extra tab stop; screenshots on the PR. Check the `MessageInput.tsx` wiring here (no unit test reaches it).
- [ ] T016 PR (do not merge): `Refs #525`, `Refs #1136`.

## Coverage

| Requirement | Task |
|---|---|
| FR-001 | T002, T003 |
| FR-002 | T003 |
| FR-003 | T001, T006, T008 |
| FR-004 | T001, T006, T008 |
| FR-005 | T003, T006 |
| FR-006, FR-007 | T004, T007 |
| FR-008 | T007 |
| FR-009 | T002, T004, T007 |
| FR-010, FR-011 | T007, T015 |
| FR-012 | T005, T008 |
| FR-013 | T008, T010 |
| FR-014 | T007, T013 |
| FR-015 | T009 |
| SC-001 to SC-007 | T002/T003, T006, T005, T009, T007, T012, T015 |
