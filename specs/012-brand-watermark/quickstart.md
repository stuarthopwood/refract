# Quickstart: verifying Brand watermark

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/ipc.md](contracts/ipc.md). Also run spec 001's own
[quickstart.md](../001-core-session-workspace/quickstart.md) prerequisites (Windows 11, `omp`
signed in, a scratch repository) since this feature reuses that app shell.

## Prerequisites

- Windows 11, with a way to turn on Windows High Contrast (`Alt+Left Shift+Print Screen`, or
  Settings > Accessibility > Contrast themes) and a screen reader (Narrator, `Win+Ctrl+Enter`).
- The prerequisite brand-asset change (branch `brand-icon-v2`) merged, so
  `src/renderer/assets/brand/refract-hero.svg` exists. Where this has not landed yet, note which
  checks were skipped and why.
- `pnpm install`, `pnpm dev` or `pnpm build` + the built app, `pnpm typecheck` — same as spec 001.

## Checks per story

**Story 1: sees Refract's own mark quietly anchored in the workspace (FR-001 to FR-009)**

1. Launch Refract with default settings (no `settings.json`, or one with no `watermarkEnabled`
   key) and open a Session. Expect: a faint, single-colour mark anchored to the bottom-right
   corner of the chat area.
2. With no Session open (or all archived), look at the "Select a Session or create one" empty
   state. Expect: the mark is visible there too.
3. Resize and maximize/restore the window. Expect: the mark's size scales smoothly between its
   documented minimum and maximum, stays anchored to the same corner, with no animation and no
   other control moving or resizing because of it.
4. Open a second pane in a split chat (spec 005). Expect: exactly one mark for the whole chat
   area, not one per pane, still anchored to the chat area's own bottom-right corner (now inside
   whichever pane visually occupies it).
5. Open and close the Subagent panel (spec 004), and hide and show the session list. Expect: the
   mark's position and size are unaffected by either.

**Story 2: turns the watermark off, or back on, in Settings (FR-010, FR-015 to FR-020)**

1. Open Settings (spec 004) and find the Appearance section (spec 007). Expect: below the theme
   picker, a switch with a label and a one-line description for the background mark, and a small
   preview showing its current state — matching the Session readout toggles' layout convention.
2. Turn the switch off. Expect: the preview updates immediately; leave Settings (Back to chat) and
   confirm the real mark in the chat area is gone, with no restart needed.
3. Turn the switch back on. Expect: the real mark reappears immediately in the chat area.
4. With the switch off, restart Refract. Expect: it reopens with the mark still off, and the
   switch in Settings still shows off.
5. Hand-edit `settings.json` to remove the `watermarkEnabled` key entirely (simulating a file
   written before this spec), then relaunch. Expect: the mark shows (the documented default),
   matching FR-019.
6. Hand-edit `settings.json` to set `"watermarkEnabled"` to a non-boolean value (e.g. `"yes"`),
   then relaunch. Expect: the mark shows (falls back to the default), matching FR-020.

**Story 3: the mark never interferes with reading, clicking, or selecting (FR-011 to FR-014)**

1. With the mark showing and an open Session with transcript history, click-and-drag to select
   transcript text that visually overlaps where the mark sits. Expect: the selection behaves
   exactly as it would with the mark off — no part of the mark is selectable, no selection is
   interrupted.
2. Click directly on the area the mark visually occupies, in both the empty state and over the
   transcript/composer. Expect: the click reaches whatever real content (or empty background) is
   there, never the mark.
3. Tab through every control in the chat area (message box, Send/Stop, readout chips, Subagents
   chip, conversation switcher). Expect: the mark is never a Tab stop.
4. Turn on a screen reader (Narrator) and browse the chat area. Expect: the mark is never
   announced.
5. Turn on Windows High Contrast mode. Expect: the mark is not shown at all, regardless of the
   Settings switch's state. Turn High Contrast back off and confirm the mark returns to whatever
   the switch is set to.
6. Run (or extend, if not yet built) `node scripts/check-theme-contrast.mjs` with the mark's
   contrast pair included. Expect: every built-in theme preset (Dark, Dark high contrast) still
   meets 4.5:1 body text / 3:1 non-text/large-text contrast with the mark present at its
   documented opacity.

**Story 4: the mark stays consistent as the layout changes (FR-007, FR-008)**

1. With a Session open, drag the session-list/chat and chat/Subagent-panel dividers through their
   full range. Expect: the mark's position/size inside the chat area is unaffected; it never
   visibly jumps or flickers mid-drag.
2. Open and close the Subagent panel repeatedly. Expect: the mark is never duplicated and never
   disappears except when the whole chat area itself is hidden (e.g. Settings is open).
3. Open and close a split chat pane repeatedly (spec 005). Expect: exactly one mark at every point,
   never two, never zero (while a Session is open and the setting is on).
4. Narrow the window until the chat area sits at its 360px minimum pane width (spec 005
   research.md Decision 6). Expect: the mark still fits inside the corner at its documented
   minimum size, with no visible overflow or mid-shape clipping.
5. Open Settings, the Readiness (first-run) screen (if reachable — delete all repositories or use
   a fresh profile), and, once spec 008 builds it, Manage sessions. Expect: the real mark is not
   shown on any of these three screens, only the Appearance section's own small preview from
   Story 2.
