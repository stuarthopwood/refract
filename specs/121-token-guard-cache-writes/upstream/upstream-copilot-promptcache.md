# Draft: `promptCache` lifetimes for github-copilot Claude models (cache warming never runs)

Not filed. Target repo: can1357/oh-my-pi. Refs Refract #1672.

## Problem
`providers.cacheWarming` defaults to `idle`, but it never warms a `github-copilot` model. The warmer
(`packages/coding-agent/src/session/cache-warmer.ts`) looks up the lifetime as
`model.promptCache?.[retentionTier]` (`oQt`) and skips the model when it is undefined. OMP's model data
sets `promptCache` only for anthropic, bedrock and factory-droid models, so every github-copilot model
resolves to "no declared lifetime" and is never warmed. docs/settings.md says so itself: "Models without a
declared lifetime for the retention tier used ... are never warmed."

## Evidence (Refract usage database, last 30 days)
- github-copilot shows 24 warm-like calls out of 257k messages.
- Main-session gaps of 300-3600 s are 3.4% of messages but 56.3% of main-session cache-write cost.
- Cache writes are about $5.3k of $12.9k total spend.

## What I checked
- `modelOverrides.promptCache` is honoured (docs/models.md "Prompt cache lifetimes", highest priority) but is read only
  from `models.yml` (`ModelRegistry` loads `models.yml` through its `ConfigFile("models")`). `--config` overlays
  are settings-layer files; no settings entry carries `modelOverrides`, and the registry uses its `settings` object only for
  disabled providers and the context-window toggle. So a host that launches OMP with `--config` cannot supply it.

## Ask
1. Ship `promptCache: {short: 300}` catalog metadata for github-copilot Claude models (the endpoint forwards
   Anthropic cache_control; 5m is the conservative lifetime).
2. Optionally accept `providers.<id>.modelOverrides` (or a `modelOverrides` entry) from `--config` overlays so hosts can
   set it without touching the user's `models.yml`.

## Acceptance
With `providers.cacheWarming: idle` and a github-copilot Claude model, an idle main session refreshes its cache
before 5 minutes while the expected avoided-miss cost exceeds the refresh cost.
