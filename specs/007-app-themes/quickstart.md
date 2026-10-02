# Quickstart: verifying App themes

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/ipc.md](contracts/ipc.md). Also run spec 001's own
[quickstart.md](../001-core-session-workspace/quickstart.md) prerequisites (Windows 11, `omp`
signed in, a scratch repository) since this feature reuses that app shell.

## Prerequisites

- Windows 11, with a way to turn on a reduced-motion setting.
- Spec 004's Settings screen built (hosts the Appearance section, User Story 2) and spec 001 T100
  (hidden title bar / `titleBarOverlay`) landed (window-chrome checks in Story 2 and 4). Where a
  dependency has not landed yet, run every other check and note which ones were skipped and why.
- `pnpm install`, `pnpm dev` or `pnpm build` + the built app, `pnpm typecheck` — same as spec 001.

## Checks per story

**Story 1: opens in a sensible default preset on first launch (FR-001, FR-013)**

1. Delete `settings.json` (or use a fresh `--user-data-dir`), launch Refract. Expect: the app
   opens in its default dark preset, with no theme ever chosen yet.
2. Open Settings and confirm the theme picker marks the default preset as the currently selected
   entry.
3. Hand-edit `settings.json` to set `"theme"` to a value that is not one of the built-in preset
   ids (simulating a theme an app update removed), then relaunch. Expect: Refract falls back to
   the default preset, not a blank or stale appearance.

**Story 2: pick a theme in Settings with a live preview (FR-002 to FR-006)**

1. Open Settings (spec 004) and find the Appearance section. Expect: a picker listing every
   built-in theme, each with a name and a small colour swatch; the entry matching the currently
   active theme is marked, both in text and by colour.
2. Choose a different entry. Expect: the whole app repaints immediately to that theme's colours —
   check a pane outside Settings (for example the session list or an open chat), not only a
   sample swatch inside Settings itself.
3. With an unsaved choice previewed, press Esc. Expect: the app reverts to whichever theme was
   active before the picker was opened. Repeat using Cancel, and again by navigating to another
   screen without saving: both behave the same as Esc.
4. Choose a different entry and click Save. Expect: that theme becomes the app's persisted
   choice; restart Refract and confirm it is still active.
5. Using only the keyboard: Tab to the picker, use arrow keys to move between entries (each
   showing a visible focus indicator), and press Enter on a non-active entry. Expect: the same
   repaint as a pointer choice, and the same entry is now marked active.

**Story 3: everything follows the theme (FR-007 to FR-010, FR-014 to FR-016)**

1. Switch through every built-in dark preset one at a time (an open Session with transcript
   history helps). For each, check: the chat transcript and its tool rows, a code block
   (including one in a language with no syntax-colour entry — expect it still renders using
   that theme's base text/background colours, no error), a diff, the session list (and its four
   state icons/colours — confirm Working, Idle, Needs you, and Stopped stay distinguishable by
   icon and text, not only colour), a dialog, a menu, a toast, a tooltip or hover card, the chip
   row, scrollbars, a focus ring, and the Settings screen itself. None should keep a hard-coded
   colour regardless of the active theme.
2. Turn on the OS reduced-motion setting, then switch themes again. Expect: no animated
   transition between the old and new colours (this was already true with reduced motion off).
3. Run `node scripts/check-theme-contrast.mjs` (or the equivalent built during the Polish task).
   Expect: every built-in theme meets at least 4.5:1 for body text and 3:1 for large text and
   non-text UI parts (focus rings, scrollbar thumbs) across the surfaces in check 1.
4. Once spec 001 T066 (Mermaid rendering) has landed: ask the agent for a Mermaid diagram in each
   theme. Expect: the diagram's colours match (or stay readable against) the active theme's
   background, in every built-in theme.
5. Turn on a screen reader and repeat check 1's theme switches. Expect: nothing beyond the
   picker's own selection-state text change is announced for the repaint itself.

**Story 4: the theme survives and applies everywhere (FR-011 to FR-013)**

1. Save a specific theme, fully restart Refract. Expect: the correct theme is shown from the
   window's very first paint — no flash of another appearance first.
2. Open a split chat pane (spec 005) or a second window, once available. Expect: it shows the
   same active theme as the rest of the app immediately.
3. Start an unsaved preview in Settings, then end the Refract process from Task Manager (not a
   normal quit). Relaunch. Expect: the previously saved theme, never the preview, is what shows.
4. Delete the Settings screen's current theme and relaunch with an unknown saved value (Story 1,
   check 3) while a Session worktree is open in a second window. Expect: every window falls back
   to the default preset consistently, not just the one that happened to read the file first.

## First-task gates

These Electron/Windows facts are unverified and are checked before the work that depends on them
(constitution IV):

- A synchronous `ipcRenderer.sendSync` bootstrap call works end to end under this app's
  `sandbox: true` + `contextIsolation: true` preload build, with no observable flash in practice
  (research.md decision 4).
- `github-dark-high-contrast` is a real Shiki bundled theme name at the pinned `shiki@4.4.3`, and
  `createHighlighter` resolves it without error (research.md decision 9).
