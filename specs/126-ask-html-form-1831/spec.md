# Feature Specification: Ask card for OMP's HTML-form ask

**Feature Branch**: `feat/1831-ask-form`
**Created**: 2026-11-11
**Status**: Specified, clarified, planned; not implemented
**Input**: GitHub issue #1831 (p0, bug, chat). Trusted input is the github-actions triage comment plus the 2026-11-10 re-grill after the #520 probes, which supersedes the issue's route (a). Grill outcomes from Stuart on 2026-11-11 are recorded below. Route: specify, clarify, plan, tasks, analyze, implement.

## Problem
On OMP 18.18.3 the `ask` tool takes one HTML form (`{ html }`). An RPC host that does not offer a form dialog is asked field by field, so Refract shows one card per field (`select`, `input`, `editor` frames) with the question text lost. The Ask card is effectively broken, and #1831 blocks adopting 18.18.3. Probes show that `set_ask_dialog` does not change this: the frames still arrive per field, and the whole form is in the `tool_execution_start` `args.html`.

## Clarifications

### Session 2026-11-11 (from the 2026-11-10 re-grill and Stuart's 2026-11-11 grill)
No question reached Stuart in this step; every answer below was decided before it.

- Q: How does Refract get the form? -> A: It parses `args.html` into one card built from allow-listed fields using shared components. It never injects the HTML.
- Q: How are the per-field frames answered? -> A: On submit, Refract answers each frame in order from the card's values.
- Q: What if a frame does not match the parsed fields? -> A: If count, type or label differ, the card falls back to today's per-field cards for the remaining fields.
- Q: What if the ask times out? -> A: The card shows "Timed out, no answer" with no retry.
- Q: How does history show an ask? -> A: `details.answers` (`{name, question, answer}`) renders read-only in the same card. The saved history text is a stub and is not used.
- Q: What does "Other" do? -> A: Picking it shows an inline text box inside the card.
- Q: How do checkbox groups finish? -> A: Submit sends the "Done selecting" wire row automatically; there is no visible Done row.
- Q: Anything else? -> A: See Deferred Clarifications. Nothing in that list is guessed in this spec.

## User Scenarios & Testing

### User Story 1 - One card for the whole form (Priority: P1)
**Why**: The agent asks several questions at once; I want to answer them together.
**Acceptance Scenarios**:
1. **Given** an ask whose form has a radio group, a checkbox group and a text field, **When** it arrives, **Then** I see one card with the three fields, their questions and options, and one Submit.
2. **Given** I fill the card and press Submit, **Then** each field's value reaches the agent in the order the agent asks for it, and the card turns into its answered state.
3. **Given** a checkbox group with nothing ticked, **When** I submit, **Then** the agent receives an empty selection, with no visible Done row needed.

### User Story 2 - "Other" (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a radio or checkbox group, **When** I pick Other, **Then** a text box appears inside the card and its text is sent as my answer.
2. **Given** Other is picked and its text box is empty, **Then** what happens is a deferred clarification (required fields); no rule is built until it is decided.

### User Story 3 - Safe fallback (Priority: P1)
**Acceptance Scenarios**:
1. **Given** the form cannot be parsed, or a frame's count, type or label does not match the parsed fields, **Then** the remaining fields show as today's per-field cards and nothing is lost.
2. **Given** a form with a tag or attribute outside the allow-list, **Then** it is ignored or triggers the fallback, and it is never rendered as HTML.

### User Story 4 - Timeout and history (Priority: P2)
**Acceptance Scenarios**:
1. **Given** an ask times out, **Then** the card reads "Timed out, no answer" and offers no retry.
2. **Given** a past ask in history, **Then** the same card shows each `{question, answer}` read-only, including an empty answer for an unchecked group.

### Edge Cases
- An unchecked checkbox group saves `answer: ""` and must render as "No selection", not blank.
- Checkbox groups are re-prompted after each toggle with a `(N selected) ` title prefix; matching ignores that prefix.
- Free-text fields arrive as `input` (empty) or `editor` (textareas and prefilled inputs); both match a text field.
- Radio and checkbox groups end with an `Other (type your own)` wire row; checkbox groups also end with `Done selecting`. These rows are not shown as options.
- Old OMP versions that send a structured `questions` ask keep working through the existing path.

## Requirements
- **FR-001**: The renderer parses `args.html` of the ask tool into a field list (radio group, checkbox group, single-line text, multi-line text) with each field's question, options and any default. Unknown markup is ignored. Nothing from the HTML is inserted into the page.
- **FR-002**: A parsed form renders as one Ask card using shared components, with one Submit.
- **FR-003**: Picking "Other" in a radio or checkbox group shows an inline text box in the card; its text is sent as the answer for that field.
- **FR-004**: On submit, Refract answers each per-field frame in the order received from the card's values. For a checkbox group it sends the chosen rows then the "Done selecting" wire row automatically.
- **FR-005**: A frame whose count, type or label does not match the parsed fields switches the remaining fields to the existing per-field cards.
- **FR-006**: A timed-out ask shows "Timed out, no answer" and has no retry control.
- **FR-007**: History renders `details.answers` read-only in the same card; an empty answer reads "No selection".
- **FR-008**: Asks that carry no `html` keep today's behaviour unchanged.
- **FR-009**: The card is keyboard-operable, every field has an accessible name from its question, and state changes (submitted, timed out) are announced politely.

## Success Criteria
- **SC-001**: On OMP 18.18.3, an ask with several fields shows exactly one card, not one card per field.
- **SC-002**: Every field's answer reaches the agent as the user entered it, in a single submit.
- **SC-003**: No HTML from the agent is ever rendered as markup.
- **SC-004**: A mismatched or unparsable form never blocks answering: the user can always answer through per-field cards.

## Deferred Clarifications
Not decided by the grill or the issue; the plan and tasks must not guess them. Each needs Stuart before the named task.
1. **Cancel or dismiss**: whether the combined card has a Cancel and what it sends for the frames still pending. Until decided, the combined card has Submit only, and per-field cards keep their present controls.
2. **Required fields and validation**: whether Submit is blocked while a radio group or text field is empty, and whether an empty "Other" is rejected.
3. **Field types beyond radio, checkbox and text**: a dropdown, number or date field in the HTML. Until decided, any such field triggers the fallback.

## Assumptions
- The probe files in `C:/Users/shopwood/AppData/Local/Temp/Probe520/` (`frames-save.jsonl`, `mock-model.mjs`, `probe1-driver.mjs`) are the reference for frame shapes on OMP 18.18.3.
- Two behaviours are source-read, not observed, and must be checked against a real 18.18.3 run in the live check: the `(N selected) ` prefix on checkbox re-prompts and the `input` versus `editor` split.
- The pi-tui `parse.ts` is the reference for the field model.
- Unit tests are co-located (AGENTS.md V1): the parser, the frame-matching and answer-ordering logic, and the history mapping each carry tests.
