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
