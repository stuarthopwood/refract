# Task: Redesign the Inline "Subagents" Chat Card for Goal Clarity & Real-Time Sub-Agent Feedback

## 1. Context & Problem Statement
Our current inline `Subagents` chat card renders a flat, indented tree of raw stage directives (e.g., `Stage 1 · Rules (HARD)` or truncated worktree paths `Stage 1 · Repo C:/Repos/Work/...`) and cryptic sub-agent IDs (`Diag1788b`, `GateTests757m`, `Verify1788`). 

This causes three major UX failures inside the chat view:
1. **No Goal Alignment:** The user cannot tell what the overall multi-stage run is trying to achieve or why a specific stage was spawned.
2. **Opaque History ("What did they actually do?"):** Completed stages only show a green checkmark and duration (`38m 50s`), hiding what defects were found, what files were changed, or which upstream gate triggered a downstream fix.
3. **Silent Long-Running Agents ("How is it hanging?"):** When a sub-agent runs for a long time (e.g., `Verify1788 Running` for 59m), the card shows no sub-step progress or heartbeat, forcing the user to message the main agent to ask if the process is hung.

---

## 2. Core Design & UX Requirements

Redesign the inline `Subagents` chat card to fit natively within our dark-mode chat stream (`#0d0d10` card surface, `#121216` header, `border-zinc-800/90`, emerald status accents) with the following hierarchy:

### A. Overall Goal & Progress Strip (Top of Card, Below Header)
- **Overall Goal Display:** Immediately below the `Subagents (X stages, Y agents, Z running)` header bar, render a dedicated Goal Strip displaying the high-level objective of the sub-agent orchestration in plain English (e.g., *"Goal: Pass app-wide quality gates & fix all detected defects for Patient Activation (PORT-757)"* or *"Goal: Harden session DeleteDialog (#1788) & verify all 6 live-check scenarios pass"*).
- **Deduplicated Context:** Strip repetitive boilerplate (such as worktree file paths or `Rules (HARD)`) out of individual stage titles and deduplicate them into the header/goal metadata.
- **Segmented Stage Progress Bar:** On the right side of the Goal Strip, render a compact segmented pill bar (`completedStages / totalStages done`) where completed stages are solid emerald, queued stages are muted zinc, and the actively running stage pulses.

### B. Individual Stage Goals & Outcome Summaries
Every stage row along the vertical execution spine must clearly communicate **Intent (Goal)** and **Result (Outcome)**:
- **Human-Readable Stage Goal Title:** Replace raw CLI/prompt prefixes with a concise, human-readable stage goal (e.g., `Stage 2 · Run app-wide quality gates` or `Stage 3 · Apply code, a11y & doc fixes from gate`).
- **Persistent 1-Line Outcome Summary:** Directly beneath the stage title (visible even when the stage is collapsed), render a 1-line summary synthesized from the sub-agents' results:
  - *When Completed:* Summarize the net outcome (e.g., `"Audited tests, code, security & a11y in parallel → flagged 3 items to fix"` or `"Added 8 integration tests for split SQL handler (coverage 79% → 88.5%)"`).
  - *When Running:* Summarize the active focus (e.g., `"5 of 6 scenarios passed · currently running final scenario (f)"`).
- **Single-Agent vs. Parallel Multi-Agent Stages:**
  - **Single-Agent Stage:** Consolidate the stage goal and the sub-agent chip (`AdrRenumber757`) on the same header line so the user does not have to expand a single-child tree just to see which agent ran.
  - **Parallel Fan-Out Stage:** Display a `N parallel` badge (`GitFork` icon) on the stage header. When expanded, render the sub-agents in a responsive 2-column grid to visually distinguish concurrent execution from serial steps.

### C. Sub-Agent Feedback Loop (Feeding Updates Back into the Main Chat Card)
Sub-agents must stream structured state updates back to the parent orchestrator so the chat card updates live without requiring user intervention:

1. **Sub-Agent Role & Action Summary (`whatItDid`):**
   - Each sub-agent card displays its ID (`GateA11y757m`), a short semantic role (`Accessibility Gate`), and a plain-English summary of what it is doing or what it concluded (`"Flagged 1 minor badge contrast issue & 1 medium WCAG 320px reflow defect"`).
2. **Causal Provenance (`triggeredBy`):**
   - When a downstream sub-agent is spawned to fix or verify a finding from an earlier sub-agent, display a causal link badge: `↳ fixes issue from GateA11y757m`. This visualizes the DAG flow between sub-nodes using zero extra vertical space.
3. **Artifact & File Mutation Chips (`filesChanged`):**
   - As sub-agents modify files, feed the basenames back into the sub-agent card as compact monospace file chips (e.g., `activation.handler.ts`, `PatientActivationModal.tsx`).
4. **Live Heartbeat & Sub-Step Checklist (`liveDetail` + `subSteps`):**
   - While a sub-agent has `status === 'running'`, stream its latest activity string (`liveDetail`, e.g., `"On scenario (f) [6/6] · Slowed by high disk I/O from parallel cargo test"`) and a live sub-step checklist (`done` ✓, `running` spinner, `pending` ○).
   - This directly prevents the *"How is it hanging?"* problem by showing the user the exact scenario/assertion currently executing and any environmental bottlenecks.
