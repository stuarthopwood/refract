# Open questions carved out of spec 014 (side chat)

Per the constitution's Incremental Enhancement rule (same pattern spec 013 used for its own four
issue://538 items): these depend on unbuilt infrastructure or an unconfirmed Stuart preference, and
do not block the spec's P1/P2 stories.

1. **A keyboard shortcut to open/focus the Side chat panel.** Issue://1 suggested "for example
   Ctrl+/" but did not require it. `docs/design/index.md`'s existing keyboard table needs checking
   for a conflict before picking one.
2. **"Use as context" per-answer action.** Issue://1 ties this to issue://465 (`@` mentions in the
   composer), which is unbuilt. Revisit once #465 ships.
3. **Model and token cost shown per answer.** Issue://516's own open question. `get_state`'s
   `model` field is already read elsewhere (readout chips) for the main turn; this is a smaller
   follow-up once the panel itself ships.
4. **`get_btw_history`'s pagination/limit behaviour for a very long thread.** Undocumented in the
   excerpts read for this spec (issue://516's summary of `omp://rpc.md`); revisit if a real long
   history is seen to misbehave.
5. **`get_btw_history` after a restart for a Session that never sent a main composer message:
   history is not shown. SC-002 is unmet specifically for this case (spec.md Clarification;
   met otherwise -- see item 6).** Live-verified (2026-10-11, Slice 1+2 round, `tasks.md` T012):
   `SessionAgent.attachAndVerify` only issues `switch_session` when `session.currentConversation`
   is set, so a Session used ONLY for side-chat (never a single main message) has nothing for a
   restarted process to reattach to, and `get_btw_history` returns empty -- from the app's
   perspective the history is gone, even though the on-disk `btw-history/entry-<id>.json` file
   itself still exists and is not deleted (corrected 2026-10-11, gate-fix round 2, Verif2 Medium:
   "confirmed NOT data loss" earlier overstated this -- the user sees it as lost, the file is
   merely unreachable from the app without a conversation to switch onto). Re-confirmed round 3
   (Verif3): a side-chat-only Session (no `chat.send` ever issued) restarted in this round's own
   scratch verification also returned an empty `get_btw_history`, matching this account exactly.
   Whether asking `/btw` before any main message is common enough to matter in practice is
   untested; revisit if Stuart reports hitting this with a real Session, or fix by having
   `SessionAgent` reattach to this Session's own side-chat context independent of
   `currentConversation`.
6. **RESOLVED (round 3, Code3/Verif3 HIGH) -- continuing a topic failed after a restart because
   Refract was sending the WRONG id, not because OMP forgets topics across a restart.** The
   round-2 account above assumed `leafId` was "a volatile, process-lifetime identifier OMP does
   not keep valid across a restart" -- live-tested this round (scratch verification, restarted
   omp process, a real main conversation present): sending the SAME topic's own root `id` as
   `recordId` succeeded immediately after the restart (the new question landed as a further
   follow-up of the same topic, confirmed three separate times across three separate restarts in
   this round's own verification pass); sending that topic's `leafId` instead was rejected every
   time with `"Unknown /btw topic: <id>"` (an RPC-level `success:false`, never a `status:"error"`
   record -- corrects a second wrong claim from `contracts/ipc.md`, also fixed this round).
   `leafId` was never a valid continuation id at all, in any OMP process life -- it is not a
   volatile value that EXPIRES, it is simply the wrong field. **Fix**: `loadHistory`
   (`side-chat-store.ts`) now seeds `activeTopicRecordId` from the last topic's root `id`, never
   its `leafId`; a safety net in `ask`'s failure branch resets `activeTopicRecordId` to
   `undefined` whenever the `recordId` it just sent is rejected and still the current one, so a
   wrong id (from this cause or any other) can never lock a Session's side chat permanently --
   the next question simply starts a fresh topic (FR-003's own documented fallback). **Still
   unknown** (logged, not guessed): what `leafId` itself denotes inside OMP's own model, since it
   is clearly not a continuation id -- possibly an internal pointer unrelated to anything a
   client ever needs. Revisit only if a future `btw` capability turns out to need it.
