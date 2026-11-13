# Research: Live-verify the token guard keys (#1935)

Facts from the OMP docs on this machine (omp 18.17.0) that shape the probes. Nothing here is a probe result; results go to `specs/021-token-guard/research.md` section 11 at implement.

## Live-reload evidence already documented by OMP

- `advisor.reviewMode`: settings.md says "Applies live" on the row (default advisor only; a `WATCHDOG.yml` roster sets its own, and Stuart's rule forbids creating one). The probe still has to observe it (the docs are not proof for the label).
- `prewalk.enabled`: prewalk.md says "In a top-level session, changing `prewalk.enabled` live also takes effect: turning it on arms the `prewalk.into` target when none is armed".
- `task.maxConcurrency`: task.md says one session-scoped `Semaphore` is "resized from the live `task.maxConcurrency` setting before every acquire and release".
- `compaction.idle*`: compaction.md and sdk.md say the idle timer belongs to the idle-maintenance scheduler, which only the TUI enables; `idleTimeoutSeconds` has a 60 s minimum.
- `plan.defaultOnStartup`: "Start each fresh interactive session in plan mode"; print/JSON mode ignores it. Whether rpc-ui reads it per turn is unknown; the probe decides (OQ-2).
- `autolearn.autoContinue`: "After an eligible primary stop, run a private capture turn"; needs `autolearn.minToolCalls` completed tool calls (default 5), so the probe lowers it in the scratch config.
- `task.softRequestBudget`: default 200, `0` disables; notice at the budget when `task.softRequestBudgetNotice` is on, force-stop at 1.5 times the budget; bundled scout/sonic agents cap at 100.
- `grep.contextBefore` / `grep.contextAfter` (defaults 1 and 3): grep.md says the tool reads them from session settings when it runs. `read.defaultLimit` (300), `read.summarize.enabled` and `tools.artifactSpillThreshold` (50 KB) have defaults in settings.md; no doc line says when they are read, so the probe decides.

## Why a marker, not a prompt hash

#1765 compared whole-prompt hashes and they differed run to run. The reason is not recorded. The probes compare one marker per key (text present or absent, request model id, request count) and run a no-edit control to show that marker is stable.

## Open items carried from the spec

OQ-1 (idle keys), OQ-2 (`/new`-only keys), OQ-3 (probe location). No decision here replaces Stuart's answer.
