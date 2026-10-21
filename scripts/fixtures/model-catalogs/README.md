# Model catalog fixtures

Fixtures for `scripts/verify-tauri-fake-omp.mjs`'s one-shot `omp models --kind <kind> --json`
handling (issue #1069), read via `REFRACT_FAKE_OMP_MODEL_CATALOG` (a path to one of these files).
Each file is `{ [catalogKind]: ModelCatalogEntry[] }` (`provider`, `id`, `selector`, `name`,
`reasoning`, `thinking` -- exactly the shape `src/shared/model.ts`'s `ModelCatalogEntry` and
`src-tauri/src/ipc/model_roles.rs`'s `parse_catalog_response` produce from the real CLI).

Unlike `../omp-frames/*.jsonl`, these are **entirely hand-written**, not sanitised recordings of a
real `omp models --kind chat --json` call. **Correction (2026-10-22, gate round 2, #1114):** an
earlier cut of this file claimed `off`/`auto`/`max` are "never reported as a catalog `thinking`
level" -- re-verified live against a real `omp models --kind chat --json` (87 chat models):
`off`/`auto` are indeed never reported (confirmed again), but `max` IS real and common (31 of 87
models, including Claude Fable 5, Claude Haiku 5.5, Claude Opus 5.5 and GPT-5.6 Terra -- every
named real model this fixture already echoes). `reasoning: boolean`, `thinking: string[] | null`,
never an empty array when `reasoning` is true, still hold.

| File | Used by | Covers |
|---|---|---|
| `chat-1069.json` | `verify-1069-roles-overhaul.mjs` | Two providers (`github-copilot`, `anthropic`) with a mix of reasoning and non-reasoning chat models and partial `thinking` arrays, so a live check can prove provider filtering, the off-provider "via" tag, and the reasoning radios' enabled/disabled set without guessing at a real catalog's exact contents. One entry each for `image`/`search`/`tts`/`stt`/`judge` so the five model-kind roles still resolve a current model for their own trigger text. |

Extend an existing file's own `chat` array for a new scenario in the same story; add a new file
only for a genuinely different story (AGENTS.md: no new fixtures where an existing one already
covers the need).
