# Tasks: Ask card for OMP's HTML-form ask (#1831)

Paths are under `src/renderer/features/chat/askForm/` unless noted. Each logic task carries a co-located `*.test.ts` (AGENTS.md V1). Order: T001 to T007 are sequential except where marked [P].

- [x] T001 [P] `parseAskHtml.ts` (with `htmlTree.ts`, an inert tokenizer) plus test: radio, checkbox, text, textarea, `required`, unknown markup ignored, any other field type returns `null`, no HTML reaches the DOM (FR-001, SC-003)
- [ ] T002 [P] `answerPlan.ts` plus test: radio, checkbox with automatic `Done selecting`, empty checkbox group, "Other" with text, an Other choice with an empty text box counts as unanswered, text field (FR-003, FR-004, FR-011)
- [x] T003 `matchFrame.ts` plus test: type and label match, `(N selected) ` prefix stripped, `Other (type your own)` and `Done selecting` rows skipped, `input` and `editor` both match text, mismatch returns `null` (FR-005)
- [ ] T004 `useAskFormSession.ts` plus test: values, submit, in-order answering as frames arrive, fallback on mismatch for the remaining fields, cancel of every pending frame, `canSubmit` false while a `required` field is unanswered (FR-004, FR-005, FR-010, FR-011, SC-002, SC-004)
- [ ] T005 `AskFormCard.tsx`: combined card on shared components, inline "Other" box, Submit (disabled per FR-011) and Cancel with Esc (FR-010), extend a shared component by prop or slot where needed; labelled groups and polite announcements (FR-002, FR-003, FR-009, FR-010, FR-011)
- [ ] T006 Read-only history mode from `details.answers`, "No selection" for an empty answer, plus mapping test (FR-007)
- [ ] T007 Timed-out state "Timed out, no answer", no retry (FR-006)
- [ ] T008 Wire into `RequestCard.tsx`, `TranscriptRow.tsx:128` and `Transcript.tsx` `findPrecedingAskItem`; asks without `html` keep today's path with a regression test (FR-008)
- [ ] T009 Keep `src-tauri/src/session/agent/` unchanged; confirm with a diff at the end (plan decision)
- [ ] T010 Docs: `docs/design/` Ask card entry if one exists, `docs/FINDINGS.md` row for the 18.18.3 ask frames, `docs/PLAN.md` row status
- [ ] T011 `pnpm ci:local` and the live check in `C:/Users/shopwood/refract-live-check-1831/`: fake omp for sequencing, fallback and timeout; one real 18.18.3 run for the `(N selected) ` prefix and the `input` versus `editor` split. Needs a free build slot and 6 GB free on C:
- [x] T012 Stuart's answers to the three deferred clarifications recorded in `spec.md` (2026-11-11): Cancel with Esc cancels every pending frame; `required` fields gate Submit and an empty Other is unanswered; radio, checkbox, text and textarea only, any other type falls back. Spec, plan and tasks updated.
