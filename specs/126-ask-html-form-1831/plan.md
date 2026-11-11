# Plan: Ask card for OMP's HTML-form ask (#1831)

**Spec**: `specs/126-ask-html-form-1831/spec.md` | **Issue**: #1831 | **Branch**: `feat/1831-ask-form`

## Technical context
- Frames: on OMP 18.18.3, `ask` arrives as `select`, `input` and `editor` frames. `classify_dialog` (`requests.rs:134-245`) already maps them to `PendingRequest::Question { title, options, input_kind: "choice" | "text" }`, and the answer goes back through the existing request-answer call. The full form is already in the ask tool item's `args.html` (`item.args` in `RequestCard.tsx`, `readAskQuestions`). Rust needs to forward nothing new.
- Constraints: constitution and AGENTS.md rules apply (shared components in `src/renderer/components/`, files under 600 lines, "why"-only comments, co-located tests per V1). #1835 waits on this lane, so `src-tauri/src/session/agent/` stays untouched.

## Decision: parser location
**TypeScript in the renderer** (`src/renderer/features/chat/askForm/`). Reason: the renderer already holds `args.html`, owns the card and the answer sequencing, and a Rust parser would need a new HTML crate (only transitive `html5ever` exists) and a new wire field in `src-tauri/src/session/agent/`, which this lane must keep minimal. Rust changes: none. (The misleading `ask_dialog_enabled` probe at `launch_support.rs:170-194` is left alone; it is not needed for the fix.)

The parser reads the HTML with `htmlTree.ts`, a small tokenizer that builds plain objects (the repo's vitest runs in `node` with no DOM library, and a tokenizer keeps the HTML inert by construction). It walks only allow-listed elements and never uses `DOMParser` or `innerHTML`.

## Design
Files under `src/renderer/features/chat/askForm/`, each under 600 lines:
- `parseAskHtml.ts`: `parseAskHtml(html) -> AskFormField[] | null`. Fields: `radio | checkbox | text | textarea`, each with `name`, `question`, `required`, `defaultValue`, and `options` for the choice kinds. `null` means unparsable, no fields, or any other field type (fallback). `htmlTree.ts` holds the tokenizer.
- `matchFrame.ts`: `matchFrame(fields, cursor, request) -> FrameMatch | null`. Compares type and label with the `(N selected) ` title prefix stripped, skips the Other and Done wire rows, and returns the exact wire row for each option. A mismatch returns `null`.
- `answerPlan.ts`: turns a field's value into the ordered wire answers: radio is the option label, or the `Other (type your own)` row then the typed text; checkbox is each toggled row then `Done selecting`; text is the string. An empty group sends only `Done selecting`.
- `useAskFormSession.ts`: holds the card values, submit state and the cursor. On submit it answers each arriving `Question` request via the existing answer function; a failed match sets `fallback` for the remaining fields. Cancel (and Esc) cancels every frame still pending. `canSubmit` is false while a `required` field is unanswered; an Other choice with an empty text box counts as unanswered.
- `AskFormCard.tsx`: the combined card, built on the shared form, radio, checkbox, text and button components, with an inline "Other" input, Submit and Cancel. Extend a shared component by prop or slot where one lacks a feature.
- `AskFormHistory.tsx` or a read-only mode of `AskFormCard`: renders `details.answers`; empty answer reads "No selection".
- Wire-up: `RequestCard.tsx` and `TranscriptRow.tsx:128` choose `AskFormCard` when `parseAskHtml(args.html)` succeeds, else today's path; `Transcript.tsx` `findPrecedingAskItem` keeps pairing frames with the ask item.
- Timeout: a timed-out ask item shows "Timed out, no answer" with no retry.
- A11y (FR-009): each field is a labelled group, a polite live region announces submitted and timed out.

## Constitution check
Principles are unchanged: no new dependency (a small in-repo tokenizer), no model cost, no HTML injection, shared components, Rust untouched. No violation to justify.

## Risks
- The `(N selected) ` prefix and the `input` versus `editor` split are source-read, not observed; the live check must confirm them on a real 18.18.3 run, and `matchFrame` is lenient on both.
- Scope is settled by Stuart's 2026-11-11 answers: Cancel with Esc, `required` gating Submit, and radio, checkbox, text and textarea only (any other type falls back).

## Checks
Typecheck, `check:file-size|comment-density|spacing|literal-colours|indent|parity`, `pnpm ci:local`. Live check with the fake omp (`pnpm verify:tauri`) for sequencing and fallback, plus one real OMP 18.18.3 run for the two source-read assumptions.
