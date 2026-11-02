# Spec 110: Token guard defaults, prewalk and plan mode off (issues #1545, #695)

Status: gate passed, awaiting merge. Grill outcomes: the decision blocks at the top of #1545 and #695 (Stuart, 2026-11-02). Closes #1545 and #695. Specify route hand-authored (no slash prompts in this lane); clarify, plan and analyze are folded into the decisions below.

## Requirements

- FR-1 The launch overlay writes `read.defaultLimit` 1000, `read.summarize.enabled` false and `todo.eager` `default` (enum `default|preferred|always`, from `omp config list`).
- FR-2 Settings > Advanced shows the two new keys under Tool output, with plain-English text, Default and Reset.
- FR-3 A saved `read.defaultLimit` of exactly 200 becomes 1000 once, on first start after the upgrade; any other saved value stays.
- FR-4 Six call-adding candidates are measured; the table is recorded on #1545. Only those that add calls are guarded off; the rest are listed with the reason.
- FR-5 Settings > Advanced gains a Session start group: "Start Sessions with prewalk" (`prewalk.enabled`, default off) and "Start in plan mode" (`plan.defaultOnStartup`, default off). The overlay always writes both, so they beat the user's global `~/.omp/agent/config.yml`. When prewalk is off the overlay also writes `prewalk.auto` `off`.
- FR-6 A Session row menu item arms or cancels prewalk by sending `/prewalk` or `/prewalk off` (probed on OMP 18.14.0: both work, and `/prewalk` arms even when `prewalk.enabled` is false). The allowlists in `slash-commands.ts` and `commands.rs` pass `off`.
- FR-7 The menu says "armed" only after OMP reported it (a `command_output` or a `source: prewalk` notice). Before any report the state is unknown and the label claims nothing.
- FR-8 `task.prewalk` and `advisor.enabled` are untouched.
- FR-9 The "Start in plan mode" value is read through `useTokenGuardStore` (`values['plan.defaultOnStartup']`) so #433's composer menu can reuse it.

## Out of scope

New tests (prototyping phase), #433's working-mode menu, the advisor, and the full benchmark rerun (Stuart proved 20 to 13 calls and $1.45 to $0.82 by hand on 2026-11-02; Copilot made 12).

## Acceptance

`pnpm ci:local` green and `verify-tauri-110.mjs` reports PASS from the pushed HEAD.
