# Quickstart: verifying Right pane shell

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/ipc.md](contracts/ipc.md).

## Prerequisites

- Windows 11, `pnpm install`, `pnpm dev` (or `pnpm build` + the built app), `pnpm typecheck`,
  `pnpm check:ui-text`, `pnpm check:theme-contrast` — same as every prior spec.
- An isolated scratch instance with its own `--user-data-dir`, never Stuart's real profile
  (repo-wide safe-verification rule).
- At least one repository with an open Session, and a turn that starts one or more subagents (any
  prompt that triggers a `task` tool call), to exercise the Subagents panel's live count.
- A window resized to 380px and to 1280px wide (SC-007), plus the default launch size.

## Checks per story

**Story 1: open and switch between right-hand panels through one shell (FR-001 to FR-011)**

1. Launch with the pane collapsed (default). Expect: a narrow icon rail with three buttons
   (Subagents, FDB Knowledge, Agent Builder) stays visible at the window's right edge.
2. Click the Subagents rail icon. Expect: the pane opens at 320px showing the Subagents panel's
   own title row and Close button — no tab strip.
3. Click the FDB Knowledge rail icon. Expect: a two-tab bar replaces the title row, both tabs
   visible, FDB Knowledge active; each tab shows its own icon and name.
4. Click the Subagents tab, then the FDB Knowledge tab. Expect: content switches each time, the
   active tab visibly marked by more than colour.
5. Tab to the tab bar, press the Right arrow key, then Delete. Expect: focus moves to the other
   tab, then Delete closes whichever tab is focused.
6. Close the remaining tab. Expect: the header reverts to a single title row (no tab strip).
7. Click an open panel's own rail icon again. Expect: that panel closes, same as its title-row/tab
   Close button.
8. With the pane open, look at the top-right corner at both 380px and 1280px window widths.
   Expect: the pane header reserves the window-controls corner; the chat header immediately to
   its left does not also reserve it (no doubled gap, no control hidden under the native buttons).

**Story 2: see every available panel when none is open (FR-009, FR-010)**

1. With one panel open, close it (its only tab's Close button). Expect: the pane stays open and
   shows a centred list of all three panels (icon, name, count where present), not a blank pane
   and not a collapsed rail-only state.
2. Tab to a launcher row and press Enter. Expect: that panel opens and becomes active.
3. Repeat opening two panels and closing both down to zero. Expect: the launcher shows every
   time, never only after the first occurrence.

**Story 3: the Subagents panel keeps working exactly as today (FR-015 to FR-017, regression bar)**

1. Start a turn with two subagents, one finished and one left running. Activate the Subagents
   chip above the message box (not the rail). Expect: the pane opens (if collapsed) on the
   Subagents panel, bound to this Session, exactly as on `main` today.
2. Select the running subagent. Expect: its live stream shows, updating as it works.
3. Let it finish. Expect: the panel updates in place; it does not close itself.
4. Close the panel from the shell's header. Expect: the chat pane's width and scroll position are
   completely unchanged — compare before/after with the same window size and scroll offset.
5. Drag the pane's resize handle fully shut while the Subagents panel is the only open panel.
   Expect: the pane collapses (FR-003) but the Subagents panel stays open and bound to its
   Session -- its live stream pauses while collapsed (nothing can see it at 0px wide); dragging
   the handle back open restores the same panel, bound to the same Session, with the selected
   subagent's stream live again (no desync between the dragged width and the shell's own
   `open`/`widthPx`/`openPanelIds` state, and no blank panel).
6. Open the Subagents panel via its rail icon (not the chip) while two chat panes are split.
   Expect: it binds to the currently focused pane's Session (FR-005 via
   `toggleHostedPanelFromRail`, the same ambiguous-click fallback FR-008 uses). Dragging the pane
   open with no panel bound instead shows the launcher (FR-009), never a forced default panel.
7. Start a fresh turn with no subagents in the same Session while its panel is open. Expect: the
   panel closes on its own (the existing per-turn reset), exactly as today.

**Story 4: honest empty state for FDB Knowledge and Agent Builder (FR-018, FR-019)**

1. Confirm Settings > Right pane > "Show sample data" is off (default).
2. Open FDB Knowledge from the rail. Expect: exactly one icon, one line, one next action — no
   disabled search/ask controls, no "Coming soon" label anywhere.
3. Open Agent Builder from the rail. Expect: the same three-part empty state, naming Agent
   Builder.
4. With DevTools' Network tab open (or an offline network profile), repeat steps 2-3. Expect: no
   request originates from either panel.

**Story 5: labelled sample data on demand (FR-020 to FR-022)**

1. Open Settings > Right pane. Expect: a switch labelled "Show sample data," off by default, with
   a one-line description.
2. Turn it on. Expect: no restart prompt; the switch itself shows on immediately.
3. Open FDB Knowledge. Expect: sample search/ask/agent-tools content shows, each element carrying
   a visible "Sample data" label.
4. Open Agent Builder. Expect: sample cloud-agent content shows, each element carrying the same
   label.
5. Turn the switch off while both panels are open (as tabs). Expect: both re-render to the empty
   state from Story 4 immediately, without closing or losing their place in the tab order.
6. Turn the switch on again, restart Refract, and reopen both panels. Expect: the switch is still
   on and both show sample content again, with no change needed.

**Story 6: resize the pane without a pointer drag (FR-025)**

1. With the pane open, Tab to its header's width-preset control (no pointer use at all from here
   on). Expect: three reachable options (Min/Default/Max, or equivalent labels) are present.
2. Activate each with Enter or Space. Expect: the pane's width changes to 240px, 320px, and 520px
   respectively, each confirmed by eye or by the chat pane visibly growing/shrinking in response.
3. After using a preset, drag the existing resize handle with the pointer. Expect: it continues to
   work from whatever width the preset left it at, with no jump or desync.

## Full-gate checks (every story)

- `pnpm typecheck` and `pnpm build` pass.
- `pnpm check:ui-text` passes (no leaked "FR-NNN"/spec terms in the built bundle, including the
  new Settings section and both placeholder panes).
- `pnpm check:theme-contrast` passes with no new `token missing` row (this spec introduces no new
  token; research.md decision 13).
- `pnpm check:drag-regions` (if present on the base branch) passes for the pane header's
  window-controls spacer.
- Both a 380px and a 1280px window width are screenshotted for: the rail alone (collapsed), the
  launcher, a two-tab bar, and each placeholder pane with the sample-data switch off and on.
