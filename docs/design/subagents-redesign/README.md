# Subagents chat card redesign: design reference

This folder holds the 2026-11-18 design reference bundle for epic #1931, the redesign of the inline Subagents chat card for goal clarity and live sub-agent feedback. The bundle is a standalone Vite and React mockup. `DESIGN_PROMPT.md` is the written brief, `src/components/SubagentsChatCard.tsx` is the reference layout, and `src/data/chatScenarios.ts` defines the view-model shape and two sample scenarios. The mockup hardcodes zinc and emerald colours. Do not copy them: use Refract theme tokens so the card works across Dark, Light, High Contrast and presets.

Mapping of the design to child issues:

- #1925: shared view-model and synthesis layer (`StageItem`, `SubAgentItem`, `overallGoal`, `outcomeSummary`, `whatItDid`, `triggeredBy`, `filesChanged`, `liveDetail`, `subSteps`).
- #1926: header, Goal strip, and segmented stage progress.
- #1927: stage rows with outcome summary, single-agent inline chip, and parallel layout.
- #1928: sub-agent cards with role, provenance, file chips, and live heartbeat.
- #1929: collapse, expand, auto-focus, and stage transitions.
- #1930: Subagents right-pane panel reusing the same view-model and layout.
