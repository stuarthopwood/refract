# Quickstart: verifying Side chat (`/btw`)

Refract is a prototype with no automated tests. Each check below is a manual run of the app, per
story in [spec.md](spec.md).

## Prerequisites

- Windows 11, `pnpm install`, `pnpm dev` (or `pnpm build` + the built app), `pnpm typecheck`,
  `pnpm check:ui-text`.
- OMP 18.6.3 or later signed in (constitution Principle IV's new minimum) -- `omp --version` must
  report at least 18.6.3 before the readiness gate's own version check passes.
- An isolated scratch instance with its own `--user-data-dir`, never Stuart's real profile
  (repo-wide safe-verification rule).
- At least one repository with an open Session.

## Checks per story

**Story 1: ask a side question without touching the main conversation (FR-001 to FR-002,
FR-005, FR-009 to FR-010)**

1. Open a Session, click the Side chat rail icon. Expect: the panel opens showing an empty thread
   and a focused composer.
2. Type a question, send it. Expect: a "Thinking" state, then the answer rendered as markdown once
   the terminal `btw_record` settles.
3. Before and after, call `get_messages`/compare the main transcript and message count. Expect: no
   change either way.
4. Start a normal turn in the main composer; while it is streaming, send a side question from the
   panel. Expect: both complete independently; the main turn's own stream is unaffected.

**Story 2: follow-up in the same topic (FR-003)**

1. After a completed answer, send a second message in the same panel. Expect: the request
   (inspectable via the main-process log or a temporary debug trace) carries the first answer's
   own record id as `recordId`.
2. Use Clear thread, then send a new question. Expect: the next request carries no `recordId`.

**Story 3: thread survives reopen and restart (FR-004)**

1. Ask a question, switch to a different Session's pane, switch back. Expect: the thread is still
   showing with no refetch flash (or a fast, unnoticeable one).
2. Quit and relaunch Refract against the same worktree, reopen the Session, open Side chat.
   Expect: the prior question and answer are shown, no new request sent to reconstruct them.

**Story 4: `/btw` from the main composer (FR-007)**

1. Type `/btw explain this error` in the main composer and send. Expect: it never appears in the
   main transcript; the Side chat panel opens and gains focus; the question is sent there.
2. Type `/btw` alone and send. Expect: the panel opens and focuses its own composer; no request is
   sent.

**Story 5: cancel and error handling (FR-006, FR-008)**

1. Send a question, press Cancel before it settles. Expect: `btw_cancel` is issued, the panel
   returns to an idle composer, no stuck "Thinking" state.
2. Send a question, then switch Sessions before it settles. Expect: the left Session's panel shows
   the cancellation OMP itself performed, without Refract issuing a redundant `btw_cancel`.
3. Trigger an error (if reachable without a live binary quirk -- e.g. an unknown `recordId` by
   editing `side-chat-store.ts`'s in-memory state in devtools for a scratch-only test). Expect:
   the error renders as text with an icon, never colour alone.

## Full-gate checks (every story)

- `pnpm typecheck` and `pnpm build` pass.
- `pnpm check:ui-text` passes (no leaked "FR-NNN"/spec terms in the built bundle).
- `pnpm check:theme-contrast` passes with no new `token missing` row (no new token expected: the
  panel reuses existing surface/text tokens, same as every spec-013 panel).
- `pnpm check:drag-regions` (if present on the base branch) passes.
- Both the readiness gate's version check (18.6.3 minimum) and a live `btw` round trip are
  exercised in the scratch instance, against a real signed-in OMP profile -- never Stuart's own
  Sessions.
