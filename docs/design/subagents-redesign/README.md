# Subagents chat card redesign: design reference

This folder holds the 2026-11-18 design reference bundle for epic #1931, the redesign of the inline Subagents chat card for goal clarity and live sub-agent feedback. The bundle is a standalone Vite and React mockup. `DESIGN_PROMPT.md` is the written brief, `src/components/SubagentsChatCard.tsx` is the reference layout, and `src/data/chatScenarios.ts` defines the view-model shape and two sample scenarios. The mockup hardcodes zinc and emerald colours. Do not copy them: use Refract theme tokens so the card works across Dark, Light, High Contrast and presets.

Mapping of the design to child issues:

- #1925: shared view-model and synthesis layer (`StageItem`, `SubAgentItem`, `overallGoal`, `outcomeSummary`, `whatItDid`, `triggeredBy`, `filesChanged`, `liveDetail`, `subSteps`).
- #1926: header, Goal strip, and segmented stage progress.
- #1927: stage rows with outcome summary, single-agent inline chip, and parallel layout.
- #1928: sub-agent cards with role, provenance, file chips, and live heartbeat.
- #1929: collapse, expand, auto-focus, and stage transitions.
- #1930: Subagents right-pane panel reusing the same view-model and layout.

## Calm card (#2318, FR-175 to FR-179)

The 2026-11-27 pass keeps the view-model and removes the visual noise:

- **Stage row**: three columns (`18px` status glyph, title, duration) with a hairline `--divider` between Stages. The title is 78% `--chat-foreground` (semibold while running); only the finished tick is green and only the running duration takes `--accent-text`. A running agent's spinner is `--accent-text`, not the Session working-state token.
- **Chips**: the single agent is quiet monospace text; the parallel fork badge is `⑂ N`; the causal badge, the file chips (basename only, `--command-pill-*`) and the badge carry no border.
- **Expansion**: a single agent expands flat with a 2px `--divider` guide line at the 40px mark; parallel agents are `bg-surface-1` sub-cards with a `--divider` hairline, in two columns from 448px of card width.
- **Sub-card**: one native `<button>` named "<agent>, <status>, open in Subagents panel" that opens the agent in the right-pane Subagents panel (`openHostedPanel`). The panel's Stage rows use the same insets (`pl-[42px]`).
- **Progress strip**: `h-1`; done is a 65% success fill with a success edge, running a pulsing `--accent-text` outline, queued a `--muted-foreground` edge on `--muted`; forced colours tell them apart by border style.
- **Contrast**: every foreground and background pair above is in `scripts/theme-contrast-pairs.mjs` and passes `pnpm check:theme-contrast` in all 25 themes. The hairline and the surface step stay below 3:1 outside high contrast (the accepted departure in `accessibility.md`); the sub-card is a button with its own 3:1 focus ring.
