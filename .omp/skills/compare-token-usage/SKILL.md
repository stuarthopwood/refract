---
name: compare-token-usage
description: "Compare token usage and cost between Refract/OMP and GitHub Copilot desktop: a per-day report since a date, or a like-for-like benchmark run. Use when Stuart says \"compare token usage\", \"token report\", \"how much did Refract spend\", \"run the token benchmark\", or asks for OMP vs Copilot spend."
---

# Compare token usage (Refract/OMP vs Copilot desktop)

Reports calls, fresh input, cache-write, cache-read and output tokens, context per call, list
price (USD), and premium units for each tool.

- OMP side: `scripts/compare.mjs` reads `~/.omp/agent/sessions/**/*.jsonl`. Refract writes every
  session there.
- Copilot side: the `session_store_sql` tool exists only in Copilot desktop. In a Refract
  session, run mode 1 OMP-only (omit the JSON file), and in mode 2 build the Copilot rows from
  the session's `events.jsonl` (see mode 2, step 2).
- Run the script from the repo root: `node .omp/skills/compare-token-usage/scripts/compare.mjs
  <args>`. A copy also lives in `~/.copilot/skills/compare-token-usage/`; keep the two in step.

## Mode 1: daily report (default)

Use this when no mode is named. The default start date is 2026-10-21, when Copilot desktop
use began. Use the date Stuart gives instead, if any.

1. Run `session_store_sql` with this query, substituting the start date:

   ```sql
   SELECT strftime(first_used_at, '%Y-%m-%d') d, usage_model, SUM(api_call_count) calls,
     SUM(input_tokens) inp, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
     SUM(output_tokens) outp, SUM(cost) units
   FROM session_usage WHERE first_used_at >= TIMESTAMP '<since>'
   GROUP BY d, usage_model ORDER BY d LIMIT 500
   ```

2. Write the rows as a JSON array of
   `{d, usage_model, calls, inp, cr, cw, outp, units}` (numbers, not strings) to
   `$env:TEMP\copilot-daily.json`. Build it in PowerShell from the returned values with
   `ConvertTo-Json`; never retype the numbers by hand.
3. Run `node .omp/skills/compare-token-usage/scripts/compare.mjs daily <since> "$env:TEMP\copilot-daily.json"`. The scan takes up to a
   minute, so use `initial_wait` 180.
4. Report the table, then the totals for each tool over the window, then one line naming the
   biggest driver (call volume, or context per call).

## Mode 2: benchmark

Use this when Stuart says "benchmark" or has just run `scripts/PROMPT.md` in both tools.

If he has not run it yet, give him the steps and stop:

Neither app opens a session on a bare folder: Stuart must add it as a project, and each app then
creates its own worktree off the project's default branch. A worktree of the real repo therefore
starts from whatever `main` is at that moment, so the two runs read different code (2026-11-02:
663 files apart). Use a standalone clone whose `main` is pinned and has no remote instead.

1. Skip this step if `C:\Repos\personal\token-bench-repo` exists and
   `git -C C:\Repos\personal\token-bench-repo rev-parse --short main` prints `0184b658`.
   Otherwise run:

   ```powershell
   git clone --no-hardlinks C:\Repos\personal\pinion C:\Repos\personal\token-bench-repo
   git -C C:\Repos\personal\token-bench-repo reset --hard 0184b658
   git -C C:\Repos\personal\token-bench-repo remote remove origin
   ```

   The `reset --hard` runs only in the fresh clone, never in the real checkout.
2. Stuart adds `C:\Repos\personal\token-bench-repo` as a project in Refract and in Copilot
   desktop (once), then starts a new session on it in each. Same model in both (default
   Claude Opus 5.5).
3. In each, paste the text below the line in
   `.omp/skills/compare-token-usage/scripts/PROMPT.md`, and wait for
   `BENCHMARK COMPLETE`.

After he has run it:

1. Find the Copilot session with this query. If it returns nothing (the store can lag), list
   `~/.copilot/session-state/*/workspace.yaml` written in the last hour and pick the one whose
   `cwd` is under a `token-bench-repo` worktree.

   ```sql
   SELECT session_id, timestamp FROM turns
   WHERE timestamp >= now() - INTERVAL '2 day'
     AND user_message ILIKE '%This is a read-only benchmark%'
   ORDER BY timestamp DESC LIMIT 5
   ```

2. Export that session's usage:

   ```sql
   SELECT usage_model, api_call_count calls, input_tokens inp, cache_read_tokens cr,
     cache_write_tokens cw, output_tokens outp, cost units
   FROM session_usage WHERE session_id = '<id>'
   ```

   Write it to `$env:TEMP\copilot-bench.json` the same way as in mode 1. If the query returns
   nothing, aggregate the `session.usage_record` events in that session's `events.jsonl`
   (`data.usage`: `model`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
   `outputTokens`, `cost`; one event per call) into the same row shape.
3. Run `git -C C:\Repos\personal\token-bench-repo worktree list`. Both apps' worktrees must sit
   on `0184b658`; if not, report the runs as not like-for-like.
4. Run `node .omp/skills/compare-token-usage/scripts/compare.mjs bench latest "$env:TEMP\copilot-bench.json"`. `latest` picks the newest
   OMP main session from the last 24 hours that contains `BENCHMARK COMPLETE`, and adds its
   side logs (for example `__advisor.jsonl`, the advisor model's calls), which are real cost.
5. Report the side-by-side table and the ratio for each row. Say that one run per side is an
   anecdote; ask him to repeat it at least twice before drawing conclusions.
6. Keep the clone for the next run. Each app's session worktree is cleaned up by archiving
   the session in that app.

## Caveats to state in every report

- Prices are list-price equivalents from OMP's own per-model rates (`RATES` in
  `compare.mjs`). Haiku and GPT models have no rate yet and price as $0.
- Premium units use a multiplier of 15 for Opus and 1 otherwise, as observed in Copilot data.
  OMP's Copilot-provider billing per call is unconfirmed; the GitHub billing usage CSV is the
  source of truth.
- Copilot's daily rows put a whole session on the day it started.
- Each harness's own overhead (system prompt, tools, hooks) is real cost and stays in.

## Gotchas

- Copilot `input_tokens` includes cache reads and writes; the script derives fresh input as
  `inp - cr - cw`. OMP `usage.input` already excludes cache.
- OMP usage sits on top-level assistant lines (`role`, `model`, `usage`, `timestamp`); there
  is no `.message` wrapper in current OMP versions. The script handles both.
- Update `RATES` when a new model appears: divide OMP's `usage.cost.<kind>` by the token count.
