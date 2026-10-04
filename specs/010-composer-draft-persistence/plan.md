# Implementation Plan: Composer draft persistence

**Branch**: `010-composer-draft-persistence` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-composer-draft-persistence/spec.md`

## Summary

`MessageInput.tsx` holds its in-progress draft text and spec 009's pending attachments in two
component-local `useState` hooks. Two existing, deliberate behaviours unmount and remount that
component -- `ChatPane.tsx`'s `key={sessionId}` on a Session switch, and `App.tsx` swapping
`SettingsScreen` in for the whole chat `ResizablePanelGroup` -- which silently discards both with
no warning. The fix: lift the draft text and pending-attachments state out of `MessageInput`'s own
`useState` into a new per-session zustand store, `src/renderer/state/draft-store.ts`, following the
exact `bySession: Record<string, T>` shape `queue-store.ts`/`commands-store.ts`/
`pending-requests-store.ts` already use. `MessageInput` reads/writes through the store keyed by
`sessionId` instead of owning the state itself, so neither unmount trigger can discard it anymore --
the fix is in where the state lives, not in either remount site.

## Technical Context

**Language/Version**: TypeScript 5.9.3 as bundled by Electron 44.5.1 / React 19.3.0 in the
renderer. Same stack as specs 001 and 009; no version change.

**Primary Dependencies**: `zustand` (already a dependency, every other `src/renderer/state/*.ts`
store uses it). No new dependency.

**Storage**: None (renderer in-memory only) -- explicitly out of scope per spec.md's Assumptions
and Clarifications; no `registry.json`/`settings.json`/`processes.json` change.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by hand per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build` must pass
before a change lands on `main`.

**Target Platform**: Windows 11 only, desktop-app (Electron), renderer, no new source root.

**Project Type**: desktop-app (Electron); same as spec 001, no new source root.

**Performance Goals**: none beyond today's -- a zustand `set` on every keystroke is the same shape
of update `queue-store.ts` and `commands-store.ts` already do on every IPC event; no new concern.

**Constraints**: none beyond today's (constitution: Windows 11 only, no automated tests, no
telemetry).

**Scale/Scope**: one new store file (`draft-store.ts`), one feature file edited
(`MessageInput.tsx`); no other file's behaviour changes. Two user stories, both built and verified
together (the second is a regression guard on the same underlying fix, not independent new code).

## Constitution Check

*GATE: passes before Phase 0 research; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | Nothing here touches OMP, the RPC wire, or `prompt`/`steer` commands at all; `chat.send`'s own arguments are built from the same `text`/`attachments` shapes as before, just read from a different in-memory location. |
| II. Session and process lifecycle | Pass | No change to how a Session is started, reattached, or killed; a draft is composer-only state with no bearing on process lifecycle. |
| III. Evidence before design | Pass, no new gate needed | This is a pure renderer-state relocation of two already-shipped, already-understood entities (spec 009's `AttachmentsState`, and the plain `text` string spec 001 already sends); no new OMP wire-level fact, no new file format, no first-task probe needed. |
| IV. Probe-before-design | Pass | No unresolved OMP behaviour this design relies on; see Summary. |
| V. Renderer sandboxed and untrusted | Pass | No new privileged operation and no new main-process surface; the store lives entirely in the renderer, same trust boundary as `queue-store.ts`/`commands-store.ts` today. |
| Platform and stack | Pass | Windows 11 only; no new dependency. |
| Development workflow | Pass | Spec Kit order followed; no automated tests scheduled; typecheck and build gate each story. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-composer-draft-persistence/
├── spec.md          # this feature's spec
├── plan.md           # this file
├── data-model.md      # the new Draft/DraftState shape
├── quickstart.md      # how to run and verify each story
└── tasks.md           # produced by /speckit.tasks
```

### Source code (repository root, additions only -- spec 001's tree is unchanged elsewhere)

```text
src/renderer/
├── state/
│   ├── draft-store.ts     # new: per-session draft text + pending attachments
│   └── index.ts            # edited: export + dev-hook registration for the new store
└── features/chat/
    └── MessageInput.tsx     # edited: reads/writes `draft-store` instead of local `useState`
```

**Structure Decision**: same single-project Electron layout every prior spec uses
(`src/{main,preload,renderer,shared}`). No new source root. One new file under the existing
`src/renderer/state/` directory (the directory every other per-session store already lives in), one
existing file edited. No change to `src/main`, `src/preload`, `src/shared`, `ChatPane.tsx`, or
`App.tsx` -- the fix is entirely in where `MessageInput.tsx`'s own two pieces of state are held, not
in either component that currently triggers the unmount.

## Design overview

- **The draft is a wire-level-adjacent value that already crosses into an outgoing command, never a
  separate concern invented for this spec.** `MessageInput.tsx`'s `handleSend` already builds
  `chat.send`'s `message`/`images` arguments from exactly the `text`/`attachments` values this spec
  relocates; nothing about that call, or anything spec 009 built around it, changes.
- **One `bySession: Record<string, Draft>` store, matching three existing stores' own shape
  exactly** (`queue-store.ts`'s `SessionQueue`, `commands-store.ts`'s per-session command list,
  `pending-requests-store.ts`'s per-session request list) -- not a new pattern invented for this
  spec. `Draft` is `{ text: string; attachments: AttachmentsState }`; a stable `EMPTY_DRAFT` constant
  (same stability reasoning `EMPTY_QUEUE`/`EMPTY_READOUT` already document: a fresh `{}` literal on
  every selector call would break `useSyncExternalStore`'s snapshot stability and loop forever)
  backs an unknown/new Session.
- **No IPC subscription, unlike every other store `init-stores.ts` wires up.** A draft is
  never pushed from main; it only ever changes because the developer typed or pasted something in
  this renderer. `draft-store.ts` therefore needs no entry in `init-stores.ts`, only in
  `index.ts`'s export list and the dev-only `window.__refractStores` hook (for quickstart's own
  CDP-driven verification, the same hook T012/T014 of spec 004 already used).
- **`MessageInput.tsx` keeps every other piece of local state exactly as it is.** Only the two
  `useState` calls for `text` and `attachments` move; `starting`, `slashActiveIndex`,
  `slashDismissed`, `attachmentAnnouncement`, `ghost`, `announcedSuggestion`, and every `useRef` stay
  local (FR-006) -- this is a storage-location change for two pieces of state, not a rewrite of the
  component's other logic, exactly as the assignment specifies.
- **Every existing call site inside `MessageInput.tsx` that reads `text`/`attachments` or calls
  `setText`/`setAttachments` is updated to read/write through the store keyed by `sessionId`,
  nothing else.** `handleSend`'s send-success clearing (today: `setText(''); setAttachments
  (EMPTY_ATTACHMENTS)`) becomes one `clear(sessionId)` store action, matching FR-005/FR-007 exactly;
  every other call site (`onChange`, `onPaste`, `completeSlashCommand`, the Tab-accept and Esc-clear
  branches of `handleKeyDown`, `handleRemoveImage`) becomes the equivalent
  `setText(sessionId, …)`/`setAttachments(sessionId, …)` call.
- **No change to `ChatPane.tsx` or `App.tsx`.** Neither remount trigger is removed or altered
  (Clarifications: both are deliberate, documented behaviour); the fix makes the remount invisible
  to the developer by ensuring the state it used to discard no longer lives inside the thing being
  remounted.
- **No cleanup of a deleted/archived Session's store entry**, matching every other per-session store
  in the app today (`queue-store.ts`, `commands-store.ts`, `transcript-store.ts`,
  `pending-requests-store.ts` all do the same); not a gap this spec was asked to close, and fixing it
  here but not the other three would be an inconsistent, unrequested change to an unrelated
  pattern.

## Complexity Tracking

None. No violations.
