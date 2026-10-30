# Spec 066: Chat Previous past Notes, suspect context window warning, Usage spacing (#1413, #1411, #1407)

One batch, three small p1 fixes. Chat Previous/Next stepping must pass short rows such as Notes (#1413). The Context usage readout and Settings > Models must flag a model whose window equals its `-1m` sibling's (#1411). The Usage view puts 32px between major sections (#1407).

## Clarifications

### Session 2026-10-30 (self-grill against CONTEXT.md, ADR 0003 and 0005, and the code; agent decisions, Stuart away)

- Q: #1413, which fix? A: Pass `scrollPreviousItemPeek={0}` to `MessageScrollerProvider`. The library uses the peek only for the observer's top exclusion and the snapshot it reports; `readCurrent` already applies the jump-inset edge itself. [Decided by Skippy] The alternative (measure all rows with `getBoundingClientRect`) is larger and drops the library's windowing of off-screen rows.
- Q: #1413, does the find bar matter? A: A larger jump inset leaves a row landed under the bar in `visibleMessageIds`; `readCurrent` still skips rows whose bottom is above the inset edge, so the current message is unchanged. ADR 0005 (one message index) is unaffected.
- Q: #1411, detect via `get_available_models` or the model catalog? A: Use the existing chat catalog (`omp models --kind chat --json`) held in `useModelRolesStore`. It is the same registry OMP serves `get_available_models` from, already loaded for the pickers, and its rows carry `contextWindow` (verified on OMP 18.13.3). No new RPC plumbing. [Decided by Skippy]
- Q: When is a window suspect? A: A model whose id does not end in `-1m` has a sibling on the same provider with id `<id>-1m`, both have a `contextWindow`, and the two are equal. Only the base model is flagged; the `-1m` variant is not. Missing windows are never suspect. The readout still shows OMP's numbers; nothing substitutes a window.
- Q: When does it clear? A: Detection is a pure function of the catalog, so it clears when the catalog is reloaded and the windows differ (an OMP update, a refresh or a `modelOverrides` entry). The catalog reloads when a Session's readout mounts (each launch) and after a model change, because `lastModel` changes the lookup.
- Q: Where is the link? A: [UI architect ruling] A tooltip cannot hold a clickable link, so the readout's shake menu gets a top item linking to can1357/oh-my-pi#17481 and the Settings notice carries the same link. The tooltip is short plain text.
- Q: Readout glyph? A: [UI architect ruling] `ReadoutItem` gets a `warning` prop that shows an amber `TriangleAlertIcon` after the figures; the accessible name mentions it.
- Q: Settings placement? A: [UI architect ruling] First in the loaded Models section, above the provider switch, as a new `warning` variant of the shared `Alert` with `role="note"`, rendered only when at least one model is suspect.
- Q: #1407? A: Usage view only, `gap-4` to `gap-8` at the column and the chart row; `p-4` and internal section spacing unchanged; equal-height cards stay because the grid does not set `items-start`.

## Functional requirements

- FR-1 (#1413): Previous and Next step through every indexed message including Notes, one per press, and never repeat a target.
- FR-2 (#1411): `ModelCatalogEntry` carries `contextWindow` (number or null); `suspectContextWindows(catalog)` returns the base models whose window equals their `-1m` sibling's, naming both.
- FR-3 (#1411): The Context usage readout shows an amber warning icon and a tooltip naming both models and windows, saying the percentage and auto-compaction may be wrong, when the Session's active model is suspect. It loads the chat catalog when needed.
- FR-4 (#1411): The shake menu shows a link item to can1357/oh-my-pi#17481 while the warning is on.
- FR-5 (#1411): Settings > Models lists suspect models with the same note and link; nothing renders when there are none.
- FR-6 (#1407): The Usage view column and chart row use `gap-8`.

## Success criteria

- Previous from the bottom of a transcript with several Notes visits each in order to the first message.
- On OMP 18.13.3 with `github-copilot/claude-opus-5.5` the warning shows and names `claude-opus-5.5` and `claude-opus-5.5-1m` at 1M; `claude-opus-4.8` shows none.
- Usage sections sit 32px apart. `pnpm ci:local` and `pnpm check:ui-text` pass.

## Out of scope

No new tests (prototyping phase). No guessed window. No change to `readout.rs` parsing.
