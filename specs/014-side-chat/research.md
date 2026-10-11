# Phase 0 Research: Side chat (`/btw`)

1. **Native `btw` RPC over `rpc-ui`, confirmed live (FINDINGS item 14, #516).** `btw` with a plain
   question returned `{success: true, data: {record: {status: "running", ...}}}` over the same
   `rpc-ui` transport Refract already uses for every other RPC command -- no separate connection or
   mode needed. `get_messages` before and after the call reported an identical message count
   (`messageCountUnchanged: true`): confirms the side question never enters the main transcript.
   After closing and reopening the process with `switch_session` onto the same session file,
   `get_btw_history` returned the same record by id (`btwHistoryHasOurRecord: true`): confirms
   restart-survival. **Not captured live**: the final answer text, a `status: "complete"` record,
   or any `btw_delta` frame (0 observed across all runs within a 20s watch window for a trivial
   question) -- the spec's User Story 1/Edge Cases explicitly require the shipped UI to be correct
   from the terminal `btw_record` alone, since that is the only completion shape actually observed.

2. **The old `runEphemeralTurn` extension route is fully dropped, not kept as a fallback.**
   Issue://516 itself asks "keep both implementations?" as an open question but the top-of-issue
   decision block (both #1 and #516, Stuart 2026-10-07) already settles it: "side chat uses OMP's
   native `btw` RPC only (no bundled extension)". `docs/spike/btw-ext.ts` and the `--extension`
   launch-argument work issue://1 originally scoped are out of this spec's build entirely; no two
   code paths, no version-gated fallback for pre-18.6.3 hosts beyond the existing readiness gate
   refusing to proceed at all (constitution Principle IV, the minimum-version check already
   present for every other feature).

3. **`/btw` moves from refused to Refract-handled-locally, same tier as `/new`/`/resume`.**
   Constitution Principle I already lists `/btw` among the commands Refract "supplies natively"
   because it was "absent over RPC" at the time that principle was written. It is no longer absent
   (item 1 above), but Refract still does not forward the literal text as a prompt -- instead of
   reimplementing turn behaviour (the thing Principle I forbids), Refract builds a client UI
   (the Side chat panel) for the real RPC command, the same relationship the app already has with
   `/new` (`new_session`) and `/resume` (`switch_session`/`open_session`). `/btw` is therefore
   removed from Principle I's "supplies natively" list (it is not a command Refract reimplements
   the behaviour of) and its own handling is described fully in Principle II's RPC Wire Contract
   section instead, replacing the old extension-based rule.

4. **Panel registration follows spec 013's existing pattern exactly, no shell changes needed.**
   `panel-registry.ts`'s `PanelId` union gains `'side-chat'`; `HOSTED_PANELS` gains a descriptor
   (icon, name, `hasCount: false` -- no live count is specified for this panel in either issue).
   `RightPaneShell.tsx`'s content switch gains one more `activePanelId === 'side-chat'` branch. No
   change to `PanelTabBar.tsx`, `IconRail.tsx`, `PanelLauncher.tsx`, or the width-preset control:
   all three already iterate `HOSTED_PANELS` generically (spec 013's own design intent, confirmed
   by reading those files -- none hard-codes the three existing panel ids in its rendering logic,
   only in `panel-registry.ts` itself and the one `activePanelId === '<id>'` switch in
   `RightPaneShell.tsx`).

5. **Icon choice: a message/chat-shaped lucide icon distinct from the three existing panels**
   (`BotIcon` subagents, `LibraryIcon` FDB Knowledge, `HammerIcon` Agent Builder -- none of which
   reads as "chat"). `lucide-react` 1.49.0 (already pinned) has `MessageCircleIcon` and
   `MessagesSquareIcon`; `MessageCircleIcon` is chosen (a single speech bubble, the more literal
   match for a one-thread side conversation; `MessagesSquareIcon`'s two-bubble mark is closer to
   "messaging app" than "one aside conversation", and spec 013's own icon choices (research.md
   decision 8) picked the single most literal shape each time).

6. **IPC and frame shape follow the existing `SUBAGENT_PATCH`/subagent-store.ts precedent, not the
   main transcript's `TRANSCRIPT_PATCH`.** The existing codebase already has a second, independent
   per-"thread" streaming pattern for exactly this shape of problem: `SubagentPanel.tsx`'s own
   store subscribes to `SUBAGENT_PATCH` events keyed by subagent id, separate from the main
   transcript entirely. Side chat reuses that shape: a new `SIDE_CHAT_PATCH` event keyed by
   Session id carrying either a `btw_delta` (append) or a full `btw_record` (replace), and a new
   `sideChat.ask`/`sideChat.cancel`/`sideChat.getHistory` request trio mirroring
   `subagents.select`/`subagents.cancel`'s own shape (`contracts/ipc.md`).

7. **No new Settings entry is needed.** Neither issue asks for a toggle; the panel's own presence
   in the rail is the only user-facing surface, same as every other spec-013 panel.

8. **Constitution amendment is this spec's own implementation work, not a separate approval
   round.** Both issues' own top-of-body decision block says the constitution edit and version
   bump "are implementation work and wait for 'implement'" -- `plan.md`'s Constitution Check cites
   the exact before/after wording for Principles I, II, and IV, and the amendment itself ships in
   this spec's docs-only PR (governance clause: "A change to a Principle II or III rule MUST cite
   the FINDINGS row or probe result behind it" -- satisfied by citing FINDINGS item 14 throughout).
