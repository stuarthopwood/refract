# Model-role RPC probe (T061)

**Date:** 2026-10-02
**OMP version:** omp/18.4.10

## Method

`docs/spike/model-role-probe.mjs` spawned `omp --mode rpc-ui --approval-mode=always-ask
--session-dir <scratch>` against Stuart's default, already-signed-in OMP profile
(no `--profile` flag, so no isolation needed for auth — this call is read-only
and never sends a prompt, `/model`, or `login`). It sent exactly four read-only
RPC requests — `get_state`, `get_available_models`,
`get_available_thinking_levels`, `get_available_commands` — and inspected the
key names of their responses (concrete model ids/paths redacted) for anything
shaped like a role, profile, tier, alias, or purpose field.

## Result

**No role is exposed over RPC on 18.4.10.**

- `get_state` keys: `model` (an object, not inspected further for sub-keys
  beyond provider/id), `thinkingLevel`, `isStreaming`, `isCompacting`,
  `steeringMode`, `followUpMode`, `interruptMode`, `sessionFile`, `sessionId`,
  `autoCompactionEnabled`, `queuedMessageCount`, `hasPendingAsyncWork`,
  `isSettled`, `queuedMessages`, `todoPhases`, `fastModeEnabled`,
  `tokensPerSecond`, `fastModeActive`, `messageCount`, `systemPrompt`,
  `dumpTools`, `contextUsage`. No `role`/`modelRole`/`roleId` field anywhere.
- One example `get_available_models` entry (67 models total) has keys: `id`,
  `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input`, `cost`,
  `contextWindow`, `maxTokens`, `int`, `tps`, `thinking`, `identity`,
  `requiresGlyphTokenization`, `tokenizer`, `webSearch`, `webSearchModel`,
  `compat`, `supportsComputerUse`. No role/tier/alias field.
- `get_available_commands` (238 commands) `model`-named command descriptor
  keys: `name`, `aliases`, `description`, `source` — `aliases` here is the
  slash-command's own aliases (e.g. `/model` vs `/m`), not a model role alias.
- Regex scan (`role|profile|tier|alias|purpose`, case-insensitive) over every
  key name and string value in all four responses matched only: command
  `aliases` (slash-command aliases, unrelated to models), free-text
  `description` strings (natural-language command/tool help text, not
  structured role data), and `compat.supportsDeveloperRole` /
  `compatConfig.supportsDeveloperRole` on model entries — an OpenAI
  Responses-API request-shaping flag (whether to send `role: "developer"`
  instead of `role: "system"`), unrelated to OMP's config-side chat/memory
  "model roles" concept (`default`/`smol`/`slow`/`vision`/`image`/… from
  `modelRoles` in `config.yml`, per `omp://models.md`).
- `omp://models.md` documents config-side **model roles** (`modelRoles` in
  `config.yml`; chat roles `default`, `smol`, `slow`, `vision`, `plan`,
  `commit`, `tiny`, `task`, `advisor`, and memory-kind roles `image`, `web`,
  `speech`, `dictation`, `judge`) used to pick which model answers a given
  kind of request, but this is a config/selection mechanism, not a field
  returned by any RPC response about the *live* model. `omp://rpc.md` does
  not mention model roles at all; its `get_state.model` shape and
  `get_available_models` schema carry only `provider` + `id` (plus
  capability/cost metadata), and `get_available_thinking_levels` returns only
  effort levels (`off`, `low`, `medium`, `high`, `xhigh`, `max` were returned
  live, `inherit`/`auto` intentionally excluded).

## Consequence for T061 / the message-box model readout

The readout must show **provider, model, and effort/thinking-level only**.
There is no `role` field anywhere in the read-only RPC surface to display
alongside them; any role the model was selected under (`default`, `smol`,
etc.) is a config-time selection detail, not something OMP reports back for a
live session.
