# Feature Specification: Typed code snippet preview in the composer (#525)

**Feature Branch**: `feat/composer-code-snippets-525` (this spec lands on `spec/525-code-snippets`)
**Created**: 2026-11-27
**Status**: Clarified (one probe pending; see Clarifications)
**Input**: GitHub issue #525 (child of the composer epic #1136). Route: specify. Builds on [spec 050](../050-composer-markdown-styling/spec.md) (the live Markdown mirror owns the textarea overlay slot) and [spec 010](../010-composer-draft-persistence/spec.md) (the draft store holds canonical text). Reuses `CodeBlock` ([ADR 0003](../../docs/adr/0003-reusable-ui-components-only.md): reusable components only).

## Clarifications

Citations are `file:line` or symbol names as read in this worktree (`origin/main` at `f6e941ab`) or "#525" for the issue and its comments. Items marked **INFERENCE** are not verified and are not product decisions; the lane that builds this either proves them (T001) or asks.

### Session 2026-11-27

- Q: Which of the issue's options (A preview strip, B in-place conversion, C rich editor) is built? -> A: Decided (Stuart 2026-10-07, #525): option B. A preview of the snippet while typing, plus the typed backticks rewritten to a clean fenced block when the pair closes. The composer stays a textarea. Option C is not built.
- Q: Where does the preview sit? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): above the textarea, inside the composer box, so the transcript never shifts. In code: the first child of `ComposerBox` (`components/ComposerBox.tsx:48`, a `flex flex-col` box that already takes children), before `ComposerField`, i.e. between `MessageInput.tsx:770` and `:771`. `AttachmentStrip` (`:758`) is outside the box and stays where it is. `ComposerBox` itself needs no change.
- Q: Is a language auto-detection library added? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): no. The language comes from the fence tag or a known alias; anything else is "text". The issue's open question about a detector and its confidence threshold is therefore closed: there is no detector and no threshold.
- Q: Inline single backticks? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): fenced blocks only. Spec 050's live Markdown styling already covers inline code (`tokenizeMarkdownDraft`, kind `code`).
- Q: How is the one-line form treated, and how does the user get a literal backtick back? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): the one-line rule (a known first word is the language; otherwise all of it is code) and Ctrl+Z as the escape hatch are adopted as written in #525.
- Q: How does this coexist with spec 050's mirror? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): the preview adds no second overlay. It is an in-flow sibling above the field, so `useCommandPillOverlay` (`CommandPillOverlay.tsx`), `ComposerMarkdownMirror` (`composerMarkdownMirror.tsx`), ghost text and chips are untouched. The draft that spec 050 styles is the canonical fenced text.
- Q: What does spec 010 store? -> A: Decided (Skippy, delegated by Stuart 2026-11-27, #525): the canonical fenced text, never a rendered representation. The rewrite goes through the textarea's own `onChange` path, so `useDraftStore` (`state/draft-store.ts`) sees an ordinary text change.
- Q: Which words count as a "known language or alias" for the one-line rule? -> A: **INFERENCE**: a curated table of about 40 common names and aliases (`ts`, `tsx`, `js`, `jsx`, `py`, `sh`, `bash`, `json`, `yaml`, `rs`, `go`, `cs`, `cpp`, `c`, `java`, `kt`, `rb`, `php`, `sql`, `html`, `css`, `md`, `ps1`, `toml`, `diff` and their long names), not all of shiki's 200-plus ids. Reason: the first word of free prose such as ```` ```go away``` ```` or ```` ```c is``` ```` must not be swallowed as a language; short shiki aliases (`c`, `r`, `v`, `d`, `go`, `log`, `make`) are common English or letters. The multi-line form (```` ```lang ```` then a newline) is not restricted: any tag is passed through, and `CodeBlock` falls back to "text" when shiki rejects it (`CodeBlock.tsx:120-130`). T002 fixes the final table.
- Q: Which block does the preview show when a draft has several? -> A: **INFERENCE**: the last fenced block in the draft, closed or still open (an unclosed fence runs to the end of the draft, the same as the bubble's CommonMark rendering). Following the caret was rejected because the textarea has no cheap caret-change signal (only `onChange` carries it) and a stale caret block is more confusing than a stable rule.
- Q: What does the preview announce? -> A: **INFERENCE**: the preview itself is `aria-hidden` and `inert` (it duplicates text the textarea already exposes, like the spec 050 mirror, FR-008 there). One polite `role="status"` line says "TypeScript code block, 3 lines" when a preview appears or its language changes, and nothing per keystroke. The display name comes from the curated table (T002). Pattern: the existing sr-only status regions in `MessageInput.tsx:740-746`.
- Q: How much of a long snippet is previewed? -> A: **INFERENCE**: up to 12 lines inside `COMPOSER_PANEL_MAX_HEIGHT_CLASS` (`components/ComposerPanel.tsx:14`, `max-h-[min(12rem,30vh)]`), then a visible "N more lines" label. No scroll region, so no new tab stop. The full text stays in the textarea.
- Q: When is the rewrite evaluated? -> A: **INFERENCE**: only after an `insertText` or `insertFromPaste` input whose caret sits directly after a closing triple backtick that ends a one-line or same-line-closed block; never on `historyUndo`/`historyRedo`, never during IME composition, never for a draft that starts with `/` (spec 050's rule, `composerMarkdownSegments`), never inside an already-open canonical fence. A pasted block whose closing fence is not at the caret is not rewritten live; the send path normalises it.
- Q: Does Ctrl+Z really undo the rewrite in one step? -> A: **INFERENCE**: yes if the rewrite goes through `applyEdit` (`composerIndent.ts:100`, `document.execCommand`), which the indent and list-continuation edits already rely on so "one edit is one native undo step" (its own comment). Not run for this feature; T001 proves it before the hook is written, including that the controlled textarea's `onChange` receives `inputType: 'historyUndo'`.
- Q: After Ctrl+Z, is the draft normalised again on send? -> A: **INFERENCE**: no. An undone rewrite sets a "literal backticks" flag for that draft until it is sent or cleared, and send-time normalisation is skipped, otherwise the escape hatch would be undone at the last moment. The flag is renderer state beside the hook, not in the draft store (spec 010 keeps the draft shape); it is lost on a Session switch, after which a literal one-line fence normalises on send. Accepted limitation; Stuart can overrule.
- Q: Does Backspace at the boundary (#525 intended behaviour 5) also escape? -> A: **INFERENCE**: no special handling. Backspace edits the canonical fence as ordinary text. Typing the closing backticks again would rewrite again, and Ctrl+Z is the documented way out.
- Q: Does send-time normalisation touch pasted chips? -> A: **INFERENCE**: no. Normalisation runs on the draft text before `substituteChips` (`attachments.ts:356`), so the text behind a chip (over the 800-character paste threshold) is never rewritten. A pasted fenced block under the threshold is normalised like a typed one.
- Q: Tilde fences and fences of four or more backticks? -> A: **INFERENCE**: previewed when canonical (CommonMark opening line, the parse spec 050 uses, `markdownLineTokens.ts:16`), but the one-line rewrite only applies to exactly three backticks, as #525 defines it.
- Q: Side chat composer (`SideChatPanel.tsx` mounts the spec 050 mirror)? -> A: **INFERENCE**: out of scope; #525 names the composer. A follow-up can mount the same hook and preview there.
- Probe **P1** (T001, pending): `applyEdit` after an `input` event yields one native undo step and `historyUndo` reaches `onChange` in the Tauri WebView2 build. If it fails, FR-004 changes to an explicit keyboard handler (Ctrl+Z restores the typed form from a stored snapshot) before T006 starts.

## User Scenarios & Testing

### User Story 1 - Type a one-line snippet and see it as code (P1)

I type ```` ```TS const bs = "x"``` ```` in the message box. The moment I type the closing backticks the text becomes a clean three-line fence, and a preview of the highlighted code appears above the box with its language label.

**Independent Test**: unit tests on the pure rewrite function plus a live check typing the example in the debug build.

**Acceptance Scenarios**:
1. **Given** an empty draft, **When** I type ```` ```TS const bs = "x"``` ````, **Then** the draft becomes "```ts", `const bs = "x"`, "```" on three lines, the caret sits on a new empty line after the closing fence, and the preview shows the code highlighted as TypeScript.
2. **Given** ```` ```hello world``` ````, **Then** no language is applied, the whole of "hello world" is the body, and the preview header reads "text".
3. **Given** ```` ```py ```` then a newline, code lines, then a closing ```` ``` ```` on its own line, **Then** the draft is unchanged (already canonical) and the preview shows Python.
4. **Given** I paste a one-line fenced block that ends at the caret, **Then** it is rewritten like a typed one.

### User Story 2 - Send a clean block (P1)

When I press Enter the agent receives a proper fenced block, and my chat bubble shows the same code through the existing highlighted `CodeBlock`.

**Acceptance Scenarios**:
1. **Given** a draft that still holds a one-line fence (pasted, caret elsewhere), **When** I send, **Then** `chat.send` receives the three-part fence.
2. **Given** a draft with no fences, **When** I send, **Then** the text is byte-identical to today.
3. **Given** a pasted text chip whose original text contains backticks, **When** I send, **Then** the chip text is substituted verbatim and never normalised.
4. **Given** the normalised text, **Then** the bubble renders it with `CodeBlock` and a language header (`Markdown.tsx:315-362`).

### User Story 3 - Keep a literal backtick (P2)

If I did not want a block, Ctrl+Z returns exactly what I typed, and it stays that way when I send.

**Acceptance Scenarios**:
1. **Given** a rewrite just happened, **When** I press Ctrl+Z, **Then** the draft is the typed one-line text and is not rewritten again.
2. **Given** that undone draft, **When** I send, **Then** the text goes as typed.

### User Story 4 - Use it with a keyboard and a screen reader (P2)

The preview adds no tab stop and no chatter. A screen reader user hears "TypeScript code block, 3 lines" once when it appears and still reads the draft in the textarea.

**Acceptance Scenarios**:
1. **Given** a preview is showing, **When** I press Tab through the composer, **Then** focus order is unchanged.
2. **Given** I keep typing inside the block, **Then** no further announcement is made until the language changes or the block goes away.
3. **Given** Reduce motion is on (OS or Settings > Appearance), **Then** the preview appears and disappears without animation.

### Edge Cases

- A draft starting with `/` (slash command): no rewrite, no preview.
- IME composition in progress: no rewrite.
- A backtick triple typed inside an already-open canonical fence is that fence's closer, never a one-line opener.
- Draft over 20,000 characters, or a block over 200 KiB: no preview (the `CodeBlock` plain fallback applies to the latter); the rewrite still applies to the former only below the 20,000 limit (shared with spec 050).
- Forced colours: the preview inherits `CodeBlock`'s forced-colours border.

## Requirements

- **FR-001** The one-line rule: after an opening triple backtick, the first word is the language when it is in the curated table (case-insensitive); the rest up to the closing triple backtick is the body. A first word not in the table gives no tag and the whole text is the body. A newline right after the language also works.
- **FR-002** A pure function returns the edit (`ComposerEdit`, `composerIndent.ts:1`) that turns a closed one-line or same-line-closed block ending at the caret into the three-part fence (opening fence with the lowercase tag, body lines, closing fence on its own line), plus a newline after the closing fence when text follows or none exists, with the caret after it.
- **FR-003** The edit is applied only through `applyEdit`, so it is one native undo step and `useDraftStore` and the spec 050 mirror see ordinary text.
- **FR-004** Ctrl+Z after a rewrite restores the typed text, does not trigger another rewrite, and suppresses send-time normalisation for that draft until it is sent or cleared.
- **FR-005** No rewrite and no preview for: a draft starting with `/`, a disabled composer, a draft longer than `MAX_STYLED_DRAFT_LENGTH` (`markdownLineTokens.ts:14`); no rewrite for `historyUndo`/`historyRedo` input, IME composition, or a backtick triple inside an open fence.
- **FR-006** A preview strip shows the last fenced block, rendered by the shared `CodeBlock` (`embedded`, `streaming` so it has no menu, Copy or Wrap), inside `ComposerBox` above the field. With no fenced block the composer markup is identical to today.
- **FR-007** The preview header shows the tag's language when shiki loads it and "text" otherwise (`CodeBlockHeader` already does this). The preview shows at most 12 lines then a visible "N more lines" label.
- **FR-008** The preview wrapper is `aria-hidden` and `inert`; it adds no tab stop and no pointer behaviour.
- **FR-009** One `role="status"` polite line announces "<Language> code block, N lines" when the preview appears or its language changes, and not on every keystroke.
- **FR-010** Appearing and disappearing use `FadeCollapse` (`components/FadeCollapse.tsx`), which mounts and unmounts at once under reduced motion.
- **FR-011** Highlighting stays off the keystroke path: the preview reads a deferred copy of the block text (`useDeferredValue`) and `CodeBlock` highlights asynchronously.
- **FR-012** On send, text is normalised (one-line forms to three-part fences) before `substituteChips`; text with no fence is byte-identical; text inside a canonical fence is untouched; the function is idempotent.
- **FR-013** No second overlay, no change to `COMPOSER_MIRROR_CLASS`, ghost text, chips or the command pill. `MessageInput.tsx` gains no more than 12 net lines and its `file-size-baseline.json` entry (1209) is not raised.
- **FR-014** No new dependency, network access or capability; snippet text is never interpreted as HTML (it reaches only `CodeBlock`'s escaped path), per constitution V.
- **FR-015** The bubble path is unchanged: a normalised fence renders through the existing `Markdown.tsx` `CodeBlock` with its language header.

## Key Entities

- **Fenced snippet**: a Markdown fence in the draft (opening fence with optional tag, body, closing fence), found by `lib/codeSnippetFence.ts`.
- **Literal-backticks flag**: per-draft, renderer-only; set by an undone rewrite, cleared on send or an empty draft.

## Success Criteria

- **SC-001** Every table alias, upper or lower case, in the one-line form normalises to the three-part fence in a unit test; a first word outside the table never becomes a tag.
- **SC-002** After a rewrite, a `historyUndo` input never triggers a second rewrite and send keeps the typed text (decision-function test and live check).
- **SC-003** A fence-free draft is byte-identical through send normalisation, and `normalise(normalise(x)) === normalise(x)` (unit test).
- **SC-004** A normalised draft renders in the bubble through `CodeBlock` with a language header (`Markdown.test.ts`).
- **SC-005** The preview markup has no focusable element, `aria-hidden` and `inert` set, and the announcement string changes only with language or presence (static markup test, live accessibility tree check).
- **SC-006** `MessageInput.tsx` is at or below its `file-size-baseline.json` value and `pnpm typecheck`, `pnpm test`, `check:file-size`, `check:theme-contrast` pass.
- **SC-007** Live in a scratch debug build: type the three examples from #525, Ctrl+Z, send, switch Session and back (spec 010), toggle Reduce motion; screenshots on the PR.

## Out of scope

Inline single-backtick formatting; language auto-detection and a language-change menu (the tag is the user's word; changing it is editing the text); a rich editor; the side chat composer; per-caret block choice; persisting the literal-backticks flag; `docs/PLAN.md` (the controller owns it).
