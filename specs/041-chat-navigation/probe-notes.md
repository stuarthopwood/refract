# Probe notes: row ids versus navigable messages (T1)

Method: code reading of `Transcript.tsx`, the four `group*` modules, `transcriptRowVisibility.ts` and the vendored `@shadcn/react` 0.3.1 message scroller. No live run: no cargo or tauri command is allowed in this work package, so every item below is marked **read** (verified in source) or **unverified live**.

## Row id versus message id

- **read** Every rendered row is `MessageScrollerItem messageId={row.id}`; the library writes it to the DOM as `data-message-id` (`dataset.messageId` in its observers). The row DOM node is therefore findable with `[data-message-id="<id>"]`.
- **read** `user` items are never wrapped by any grouper: `row.id === item.id`.
- **read** `assistant-text` items: the turn's last reply renders as itself (`row.id === item.id`). An earlier one is wrapped by `groupMidTurnProse` into `{ kind: 'mid-turn-prose', id: item.id, items: [item] }`, built from the item's own id, so `row.id === item.id` still holds and the id is stable while it streams or when it flips between the two forms.
- **read** `groupToolItems`, `groupThoughtItems`, `groupSubagentStages` and `groupAdvisoryItems` only rewrite `tool`, `thinking`, `subagent`, `advisory` and hidden-tool `notice` items; none touches `user` or `assistant-text`, so grouping never swallows a navigable message.
- **read** `rowVisibility` returns `'visible'` for `user`, `assistant-text` and `mid-turn-prose` whatever the Settings toggles (tool and thinking toggles only affect tool, stage and thought rows). A navigable message always has a mounted row (unless its turn is windowed out), except a message whose text is blank: the index skips those.
- **read** Note rows (`notice`, `advisory-run`, `agent-message`, tool and stage groups) carry their own ids, which are never navigable ids.

Decision: the navigable id is the `TranscriptItem.id` of a `user` or `assistant-text` item, and it equals the `MessageScrollerItem` id. No id translation table is needed.

## Index shape

`NavMessage { id, kind: 'user' | 'agent', turnIndex, firstLine, at?, length }`, built over the FULL transcript from `useTranscriptStore` (not the 50-turn window). `turnIndex` mirrors `splitIntoTurns`: a new turn starts at each `user` item, and items ahead of the first `user` item form turn 0. A message is windowed out when `turnIndex < hiddenCount`, where `hiddenCount` is the number of hidden turns.

## Scroller behaviour

- **read** `scrollToMessage(id)` returns `false` when the row is not mounted (windowed out) and, if the item count is still zero, queues the jump. So `jumpToMessage` reveals first and waits for the row to mount before scrolling.
- **read** `currentAnchorId` is derived from items rendered with `scrollAnchor`. Refract never sets `scrollAnchor`, so it is expected to stay `null`. The bridge derives its own `currentMessageId` (the topmost visible navigable message) from `visibleMessageIds` and the index order.
- **read** `visibleMessageIds` includes every intersecting row, not only messages (tool groups and notes too); the bridge filters to the index.
- **read** A programmatic jump during streaming: the existing `jumpToStageRow` already documents (#1021) that the vendored provider's content mutation observer can re-anchor to newly streamed content even with `autoScroll` off. `jumpToMessage` reuses the same settle loop and `autoScrollSuppressed` mechanism; the mid-stream pull-back stays **unverified live** and needs the live check.
- **unverified live** Frames needed for a 500-row far jump and landing on a not-yet-rendered row; index cost at 5,000 messages and on the 48 MB Session.


## Custom Highlight API in WebView2 (T8)

Method: reasoning from repo records, no live run (no cargo or tauri command is allowed in this work package).

- **read** `specs/016-tauri-rust-build/spike-r10a-shell.md` section 5 exercised `CSS.highlights` and `::highlight()` live over CDP against the installed WebView2 Evergreen runtime 155.0.4283.45 (Chromium 155) and recorded that both work.
- **read** The Custom Highlight API shipped in Chromium 105, and `tauri.conf.json` installs the Evergreen runtime (`webviewInstallMode: downloadBootstrapper`), so any current install has it.
- **read** `::highlight()` accepts only `color`, `background-color`, `text-decoration` and `text-shadow`, so the current match is distinguished by a heavier fill plus a solid underline, and other matches by a lighter fill (a dotted underline in High contrast), not by colour alone.

Decision: paint with `CSS.highlights`, but detect `typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'` first. When absent, `findPainter.ts` paints nothing; the match list, counts, previous/next and jump still work.
