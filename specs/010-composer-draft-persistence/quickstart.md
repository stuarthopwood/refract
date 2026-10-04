# Quickstart: verifying composer draft persistence

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); the new store's shape is in
[data-model.md](data-model.md).

## Prerequisites

- Windows 11, Git for Windows, Node 24 or newer, `pnpm`.
- `omp` 18.4.x or 18.5.x on `PATH` and signed in (only needed to actually send a message in Story
  1/2's last step; every restore check itself needs no agent turn).
- A scratch git repository with at least one commit, added to Refract as a Repository, with at
  least **two** Sessions created and open (spec 001 quickstart Story 1) -- this spec's independence
  check (FR-004, SC-003) needs two Sessions to switch between.
- A small PNG ready on the clipboard to paste (spec 009 quickstart's own prerequisite), and a long
  piece of text (over 800 characters) ready on the clipboard to paste as a second clipboard item
  when needed (Windows clipboard holds one item at a time -- paste the image first, then copy/paste
  the long text in a second pass, per spec 009's own quickstart).

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: switch sessions without losing a draft (FR-001 to FR-004, FR-006)**

1. In Session A's message box, type a short draft, e.g. "First draft for session A". Paste the PNG
   (a thumbnail appears in the attachment strip, spec 009 Story 1). Paste the long text block (a
   chip appears in the draft, spec 009 Story 2).
2. Click over to Session B in the session list. Expect: Session B's own message box (empty, or
   whatever it already had) shows, not Session A's.
3. Type a *different* short draft in Session B, e.g. "Second draft for session B", with no
   attachments.
4. Click back to Session A. Expect: the message box shows exactly "First draft for session A" with
   the cursor at its end, the PNG thumbnail is still in the attachment strip, and the text chip is
   still in the draft at its original position (FR-001 to FR-003).
5. Click the restored thumbnail. Expect: the full-size preview modal opens exactly as before
   (spec 009 FR-004). Click the restored chip. Expect: the full original pasted text opens in its
   modal exactly as before (spec 009 FR-012).
6. Switch to Session B again. Expect: it still shows exactly "Second draft for session B", with no
   trace of Session A's text, image, or chip (FR-004, SC-003).
7. Switch back to Session A once more, then send the message. Expect: the message box and
   attachment strip both clear immediately (FR-005), exactly as before this spec.
8. In Session A, paste a new long text block, then delete its chip's label by hand (select +
   Backspace, spec 009 FR-014) so it is pruned. Switch to Session B and back to Session A. Expect:
   the chip does **not** reappear -- the already-pruned state is what is restored, not the
   pre-prune state (Edge Cases).

**Story 2: round-trip through Settings without losing a draft (FR-001, FR-002, FR-003, FR-005)**

1. In the visible Session's message box, type a draft and paste the PNG (attachment strip shows a
   thumbnail).
2. Open Settings (the gear control). Expect: the chat pane (and its draft) is no longer visible --
   this is expected; Settings genuinely replaces the view (spec 004 Phase 4), nothing here changes
   that.
3. Click "Back to chat". Expect: the message box shows exactly the draft text typed in step 1, with
   the cursor at its end, and the attachment strip still shows the pasted image -- restored, not an
   empty box (FR-001, FR-002).
4. Repeat steps 2 and 3 three more times without changing the draft in between. Expect: the draft
   and its attachment are unaffected by any number of repeated round-trips -- no duplication, no
   loss (SC-002).
5. Send the message. Expect: the draft and attachment strip clear immediately (FR-005), exactly as
   before this spec.

## Verification without a real agent turn

Every restore check above (steps that say "switch away and back" or "round-trip through Settings")
needs no real OMP turn at all -- only the renderer's own store and component remounting, which can
also be driven directly through the dev-only `window.__refractStores` hook
(`src/renderer/state/index.ts`) in an `electron-vite dev` instance with CDP attached, the same
verification route spec 004's T012 and T014 already used: read
`window.__refractStores.draft.getState().bySession` before and after a scripted remount to confirm
the exact object survives unchanged. Only the final "send clears it" step in each story needs a
real, signed-in `omp` session.

## First-task gates

None. This spec introduces no new OMP wire-level fact (plan.md Constitution Check, Principle IV):
`chat.send`'s own arguments are built from the same `text`/`attachments` shapes spec 009 already
sends, only read from a different in-memory location. No probe task runs before implementation.
