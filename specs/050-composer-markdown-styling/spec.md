# Feature Specification: Composer live Markdown styling

**Feature Branch**: `composer-markdown-styling`
**Status**: Draft
**Input**: #1170 "Composer: live Markdown syntax styling while typing". Numbered 050. No existing spec covers it, so this is the specify route.

## Clarifications

### Session 2026-10-29 (self-grill, Skippy delegated by Stuart; recorded on #1170)

- Q: Already shipped? A: No. `origin/main` has no Markdown tokenizer or composer styling (searched `composerMarkdown`, `markdownLineTokens`, `composer-md`).
- Q: Approach? A: Stuart's own 2026-10-22 grill on the issue stands: text stays exactly as typed, markers stay visible and muted, styling is drawn on a mirror layer behind the transparent textarea. No new dependency.
- Q: Reuse the command pill's technique? A: Yes. `CommandPillOverlay.tsx` already proves the highlight-within-textarea shape (glyph fill masked, native caret, selection and IME underline kept on the textarea). The Markdown mirror takes the pill's mirror slot, so `MessageInput.tsx` gains no lines. A draft that starts with `/` is never styled, so the pill and the mirror never overlap.
- Q: Theme tokens (`--composer-md-*`)? A: Not added. The mirror uses `text-muted-foreground` (markers, quotes) and `text-accent-text` (list markers, italic, code), both already enforced at 4.5:1 on `--background` by `check:theme-contrast`, and the composer fill is transparent in four themes. One fewer token set to keep in step across five themes.
- Q: Bold and headings? A: `-webkit-text-stroke: 0.6px currentColor`, width-neutral. Italic is colour only. Code is colour only, no background or padding.
- Q: Which constructs? A: ATX headings, bullet, numbered and task lists, quotes, `**bold**`, `*italic*`, `` `code` `` and fenced blocks. Links, tables and images stay plain. Inside a fence nothing else is styled.
- Q: High contrast? A: `forced-colors` and `.theme-dark-high-contrast` hide the mirror and restore the textarea's own fill, so those modes see plain text.
- Q: Side chat? A: `SideChatPanel.tsx` has its own `ComposerTextarea`; it mounts the same mirror (right padding `pr-10` to match its single action button).
- Q: Long drafts? A: above 20,000 characters the draft is left plain.
- Clarify pass (self-answered): no ambiguity left that changes the implementation.

## Requirements

- **FR-001** `tokenizeMarkdownDraft` splits a draft into segments whose concatenation equals the draft exactly, tagged `plain | marker | heading | quote | listMarker | bold | italic | code`; it returns `null` when nothing needs styling.
- **FR-002** While a non-command draft has styled segments, the composer textarea masks its glyph fill and `ComposerMarkdownMirror` draws the draft beneath it; with nothing to style the composer is byte-identical to today.
- **FR-003** Styling is width-neutral: no font-size, weight, slant, letter-spacing or padding change.
- **FR-004** The mirror scrolls with the textarea and wraps identically (shared `COMPOSER_MIRROR_CLASS`, scrollbar gutter reserved).
- **FR-005** Ghost text, chips and the command pill keep working; ghost text is never styled.
- **FR-006** The side chat composer uses the same mirror.
- **FR-007** Forced colours and Dark (high contrast) fall back to plain text.
- **FR-008** The sent text, draft store value and accessible name are unchanged; the mirror is `aria-hidden`.
