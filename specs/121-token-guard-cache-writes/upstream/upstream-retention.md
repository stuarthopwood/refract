# Draft: per-agent prompt-cache retention (`cacheRetention`) for subagents

Not filed. Target repo: can1357/oh-my-pi. Refs Refract #1672.

## Problem
`providers.cacheRetention` (auto|short|long|none) is the only retention control, and it is global.
On Anthropic OAuth sessions `auto` resolves to 1h entries (`long`), which cost 2x input per cache write
versus 1.25x for 5m entries. A short-lived subagent (scout, sonic, a 20-request task run) pays the 1h write
premium for a prefix it never reads again after the run ends. Warming (`providers.cacheWarming`) cannot
help: `idle` warming only covers lifetimes under 30 minutes, so a 1h entry is never refreshed.

## Evidence (Refract usage database, last 30 days)
- Cache writes are about $5.3k of $12.9k total spend.
- Main-session gaps of 300-3600 s are 3.4% of messages but 56.3% of main-session cache-write cost.

## What I checked in OMP (installed bundle + docs)
- `providers.cacheRetention` is a single settings entry read once (`l2.get(this.settings)`) and passed to
  every stream call; `startCacheWarming` uses `a.cacheRetention ?? (setting === "auto" ? undefined : setting)`.
- There is no `task.agentCacheRetention`, no agent-frontmatter `cacheRetention`, and no per-spawn argument on
  the `task` tool. Compare `task.agentSoftRequestBudget`, `task.agentServiceTierOverrides`,
  `task.agentCompactionThresholdOverrides`, which are all exact-name per-agent records.
- Setting it globally to `short` would also cut the main session to 5m entries, which is the wrong trade
  for long-running main sessions that rely on warming.

## Ask
Add a `task.agentCacheRetention` record (exact agent name -> auto|short|long|none), same shape and
resolution rules as `task.agentServiceTierOverrides`, applied to the child session's stream options;
optionally an agent frontmatter `cacheRetention` with the setting taking precedence.

## Acceptance
- A scout/sonic child with `task.agentCacheRetention: {scout: short}` writes 5m entries while the main session keeps `auto`.
- A non-mapping or unknown value fails settings load with the same style of message as the other agent records.
