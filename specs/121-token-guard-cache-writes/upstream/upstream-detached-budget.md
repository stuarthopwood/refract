# Draft: soft request budget is disabled for woken/revived subagent runs

Not filed. Target repo: can1357/oh-my-pi. Refs Refract #1672.

## Problem
`task.softRequestBudget` (and `task.agentSoftRequestBudget`) bound only a subagent's first run. Any later run of
the same agent has no guard, and each run counts requests from zero.

## What I found in the bundle (runSubagent, `Ad`)
- First spawn: `softRequestBudget: MZe(agent.name, task.softRequestBudget, task.agentSoftRequestBudget)`, so budget
  and notice apply.
- IRC wake-turn job (a message wakes an idle/parked agent, `detached: true`): `softRequestBudget: 0,
  softRequestBudgetNotice: false`.
- Keep-alive / revive path (`NM`, `reviveSession`, pooled yield contract): `softRequestBudget: 0, softRequestBudgetNotice: false`.
- The guard (`Qt`) starts with `if (budget <= 0) return`, and `R.requests` starts at 0 in every `Ad` call, so a revived
  run neither inherits the earlier count nor a budget.
- Result: a long-lived `task` agent that is repeatedly messaged or revived can run any number of requests with no
  wrap-up notice and no 1.5x force-stop.

## Evidence (Refract usage database, last 30 days)
- Only agent type `task` passes the stop: 271 runs, p90 206 requests, max 778. Every other type peaks at 68 or fewer.
- Runs over 120 requests: 191, about $9.1k. A budget of 60 covers 84% of the over-stop cost.

## Ask
Apply the same budget and notice to woken and revived runs, and either carry the request count across revivals or
document that the budget is per run. Optionally expose `task.softRequestBudget` as a total across a lineage.

## Acceptance
A subagent woken by IRC or revived after parking receives the budget notice and is force-stopped at 1.5x the budget.
