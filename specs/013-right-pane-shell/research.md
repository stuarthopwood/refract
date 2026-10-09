# Phase 0 Research: Right pane shell

Each decision cites the file/line read live in this checkout (`origin/main` 9f23d22 unless noted)
or the design-system branch (`origin/docs/design-system-474` df69424, not yet merged). No OMP/RPC
behaviour is involved in this spec (constitution IV is not applicable), so there are no
UNVERIFIED-flagged platform facts here — every decision below is either a direct read of existing
code or a cited design-system decision.

1. **The shell is a new spec, not an amendment to spec 004 or 005** (spec.md Clarifications). Read
   `specs/004-session-readout/spec.md` FR-017 to FR-020 (the Subagents panel's own contract) and
   `App.tsx:356-406` (today's single-purpose `subagents` `ResizablePanel`): neither file's existing
   shape has a concept of "more than one hosted panel," and generalising it in place would mean
   rewriting spec 004's FR-017 wording anyway. A new spec that spec 004 is narrowly amended to
   point at (FR-017's wording only) keeps spec 004's own Subagents-specific acceptance scenarios
   intact and auditable.

2. **The existing `subagents` `ResizablePanel` is renamed/generalised to `right-pane`, not
   duplicated.** `App.tsx:357-406` already has the exact collapse/width/desync-guard logic this
   spec needs (collapsedSize 0, min 240, max 520, default 320, the `onResize` collapse-desync
   fix). Reusing this `ResizablePanel` and widening its `id`/content to the shell, rather than
   adding a second one, avoids a second set of collapse-desync bugs spec 004's own gate-fix
   history (three rounds, `subagent-store.ts` comments) already paid for once.

3. **`useSubagentPanelStore` keeps its session-binding/stream logic; only its `open`/`sessionId`
   pair for "is the panel showing" moves to the shared `OpenPanelsState`.** Read
   `subagent-store.ts:23-121`: `openPanel`, `closePanel`, `selectSubagent`, `applyPatch`, `reset`,
   `resetForNewTurn` are all genuinely Subagents-specific (session id, selected subagent id,
   fetched streams) and have nothing to do with which OTHER panels are open. Splitting "is this
   panel the active tab" (shell-owned) from "what is this panel showing" (panel-owned) means the
   shell's `OpenPanelsState` never needs to know about subagents, sessions, or streams at all —
   the same separation `readout-store.ts`'s per-session `bySession` map already keeps from the
   app-wide `view-store.ts`.

4. **The window-controls corner is reserved by the pane's own header, never by `ChatHeader`, while
   the pane is open.** Read `ChatHeader.tsx:8-11,96-98` and issue://394's root-cause comment
   (2026-10-05): today `ChatHeader`'s `reservesWindowControls` prop is driven only by split-pane
   state (`App.tsx:285,310,350`), with no awareness of whether the right pane is open, which is
   exactly the bug issue://394 reports (the Subagents panel's old Close button had no reserved
   space because `ChatHeader` kept reserving it). FR-011 makes `App.tsx` pass
   `reservesWindowControls={!rightPaneOpen}` to whichever `ChatPane` is right-most, so exactly one
   header ever reserves the corner.

5. **The Subagents panel's own header strip (`SubagentPanel.tsx:55-66`, the `h-10` row with the
   title and Close button) is replaced by the shell's shared header, not kept as a second,
   nested header.** Read `docs/design/components.md` "Panel header": every panel and pane shares
   one 40px header pattern; a panel owning its own duplicate header would be the "box inside a
   box" the zero-box rule (`components.md` "Cards and boxes") forbids once the shell's own header
   already exists above it.

6. **`Settings.showSampleData` follows `Settings.watermarkEnabled` field-for-field** (spec 012
   precedent, `model.ts:66-73`, `settings-store.ts:16`, `ipc.ts:285-286,443-444`): one boolean field
   on `Settings`, one `SETTINGS_SET_SHOW_SAMPLE_DATA` IPC constant, one
   `settings.setShowSampleData(enabled)` method returning the whole written `Settings` row, one
   `setShowSampleData` store action. No new persistence mechanism, matching the "same shape, not a
   new one" rule spec 012's own plan.md already established for a second Settings boolean.

7. **The new Settings switch lives in its own new section, "Right pane," not folded into
   "Appearance."** Read `SettingsScreen.tsx:43-46` (`SECTIONS` is a flat array of
   `{id, label}` pairs already designed for extension, FR-015 in spec 004) and
   `view-store.ts:11,59-63` (`SettingsSectionId` is a closed union the screen's `openSettings`
   function validates against). "Show sample data" is about right-pane content, not visual theme,
   so a dedicated section keeps the Appearance section themed/branding-only and gives any later
   right-pane setting (for example FR-025's width presets, if they ever need a Settings-level
   default) a home that already exists.

8. **Rail icon choices**: `BotIcon` (Subagents — already the mental model `SubagentStateIcon`'s own
   running/finished/failed/exited states use, `SubagentPanel.tsx:5`), `LibraryIcon` (FDB
   Knowledge — a knowledge-base metaphor distinct from a generic database glyph), `HammerIcon`
   (Agent Builder — a construction metaphor distinct from the Subagents bot). All three are
   `lucide-react` glyphs, matching `docs/design/foundations-icons.md`'s "every UI icon is
   lucide-react" rule; none is a brand mark, so `@tabler/icons-react` does not apply
   (`foundations-icons.md` "Library and style"). This is a plan-level starting choice
   (spec.md Assumptions), open to review during implementation, not a Stuart decision.

9. **The launcher list's row-button pattern reuses the existing list-row shape
   (`docs/design/components.md` "List rows"), not a card.** Read "Cards and boxes": the zero-box
   rule reserves boxes for the composer, decision cards, dialogs, code blocks, and chips/
   attachments; a launcher row is none of those, so it is an unboxed row (icon, label, trailing
   count) like a session row or subagent row, consistent with every other list in the app.

10. **The tab bar's close button sits inside each tab, not in a separate trailing column**,
    matching the parked prototype commit issue://394 itself cites (`1d45b68`, "a `RightPanelTabs`
    strip with per-tab close and a spacer") and the ARIA tabs pattern FR-008 requires (a tab's own
    accessible close action is conventionally part of the tab, per the WAI-ARIA Tabs pattern this
    FR cites). issue://394's own comment flags "close button inside the tablist" as a Medium
    accessibility finding on that prototype — this spec's FR-008/FR-026 (full icon-only bundle,
    plus Delete-to-close as an equally reachable keyboard path) are the fix carried forward, not a
    different structure.

11. **No new IPC event is needed for `showSampleData`'s live toggle.** Read
    `settings-store.ts:37-44` (`setWatermarkEnabled` already pushes `settings:changed`, which every
    subscribed component re-renders from) — the same existing `settings:changed` event covers
    `showSampleData` once it is one more field on the same `Settings` object; no per-feature event
    is a pattern this codebase has never used for a `Settings` boolean (watermark, readout
    visibility, theme, approval mode all share the one event).

12. **The non-drag resize alternative (FR-025, WCAG 2.5.7) is a small set of width-preset
    buttons in the pane header, calling the existing `ResizablePanel` ref's imperative API** —
    read `App.tsx:358-360`'s `panelRef={subagentPanelRef}` and its `.collapse()` call at line 394:
    `react-resizable-panels`'s `PanelImperativeAPI` (the same ref type) also exposes `.resize(size)`
    taking a percentage or a `PanelSize`; three buttons (Min/Default/Max, 240/320/520px) calling
    `.resize()` on the shell's own panel ref satisfy 2.5.7 without a new gesture, and make a
    future `#538` "persist width" increment trivial (the same three numbers become presets either
    way).

13. **No contrast/theme numbers are recomputed in this spec.** The shell reuses existing tokens
    (surface ladder, focus ring, `text-state-working`) verbatim; `pnpm check:theme-contrast`'s
    existing `PAIRS` list already covers every pair this spec touches (no new token is
    introduced), so no new contrast measurement is needed, unlike spec 012's watermark opacity
    work.
