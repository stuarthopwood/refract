# Agent Implementation Prompt: OMP Ask Tool Card & Collapsible Session Q&A Redesign

Copy and paste the prompt below directly into your coding agent:

---

## Prompt for Coding Agent

You are updating our OMP-powered agentic coding application's **HTML-based `ask` tool card** (active prompt view) and the **Session Q&A transcript display card** (`"Questions from the agent"` in the chat transcript).

Use the included reference files (`src/components/AskToolCard.tsx`, `src/components/SessionQACard.tsx`, and `omp-ask-cards-reference.html`) as the visual and behavioral specification. Preserve our compact dark OMP aesthetic (`#090A0C` canvas, `#101216` card surface, `#16181D` option surface, `#22252E` 1px borders, `#10B981` emerald accents, `#FCD34D` amber note accents) while implementing the following four requirements:

### 1. Recommended Option Indicator & Fast Decision Flow (`AskToolCard`)
- **Schema / Props Support**: Support `isRecommended?: boolean` and `recommendationReason?: string` on ask tool options.
- **Visual Treatment**:
  - Render recommended options with subtle emerald surface contrast (`bg-[#131918]` unselected, `bg-[#13221C]` selected, border `rgba(16, 185, 129, 0.25)` to `0.55`).
  - Render an inline `✦ Recommended` sub-label in `11px` emerald text (`#34D399`), followed by `· {recommendationReason}` in muted gray (`#9CA3AF`) when provided.
- **Decision Speed Accelerator**:
  - Default initial focus/selection to the recommended option(s) when a question loads so pressing `Enter` (`↵`) immediately confirms the recommended action.
  - Include a compact `Use Recommended ↵` action button in the question header that selects the recommended option(s) and submits.
  - Do **not** display recommendation ratio counters (e.g., omit `"4/5 recommended"` or `"Select 2 Recommended"` counts).

### 2. Multi-Select View (`mode: 'single' | 'multi'`)
- **Selection Mechanics**:
  - When a question specifies multi-select (`mode === 'multi'`), render square checkboxes (`CheckSquare` / `Square`) instead of radio indicators (`CircleDot` / `Circle`) and display `Select all that apply` next to the question title.
  - Allow toggling multiple options via click, number keys (`1`–`9`), or `Space` on the focused option.
  - Show a compact `{n} selected` counter in the card footer next to `Cancel` and `Confirm ↵`.

### 3. Inline Option Note via Keyboard Shortcut `'N'` (`"Press 'N' to add a note to selected option"`)
- **Footer Affordance**:
  - Render a compact interactive hint on the left side of the ask card footer:
    `Press [N] to add a note to selected option`
  - Also show a subtle `Note [N]` (or `Edit note [N]`) button on the currently selected or hovered option row.
- **Keyboard & Inline Editor Behavior**:
  - Listening for `keydown` (`e.key === 'n' || e.key === 'N'`) when focus is **not** inside an `<input>`, `<textarea>`, or `contentEditable` element must open an inline text input attached to the currently focused/selected option and auto-focus that input.
  - Pressing `Enter` inside the note input saves the note (`notesByOptionId[optionId] = text`) and closes the inline input; pressing `Escape` cancels editing.
  - Saved notes render compactly inside the option container (`Note: {noteText}`) with inline `Edit` and remove (`×`) buttons, and are submitted alongside `selectedOptionIds` in the ask tool payload.

### 4. Read-Only Collapsible Session Q&A Transcript Card (`SessionQACard`)
- **Strictly Read-Only After the Fact**:
  - Once questions are answered and rendered in the session chat transcript (`Questions from the agent`), they cannot be revised after the fact. Do **not** render `Revise` or `Edit` buttons in the transcript card.
- **Compact Header**:
  - Render a single-line clickable header (`px-3.5 py-2 bg-[#13151B] border-b border-[#1D2028]`):
    - Left: `✓ Questions from the agent · {count} answered` (no recommendation counts).
    - Right: `Expand ▾` / `Collapse ▴` toggle button.
- **Collapsed State (Scannable Decision Digest)**:
  - Collapsing the card must **not** hide what was asked and decided. Instead, render a compact 1-line-per-question digest (`px-3.5 py-1.5 divide-y divide-[#181B22]`):
    - Left: The question prompt (`text-xs font-medium text-neutral-300 truncate`).
    - Right: `→ {concise answer summary}` (`text-neutral-200`), any attached note in amber `({noteText})`, and a subtle emerald sparkle icon if the recommended option was chosen.
    - Clicking any row in the collapsed digest toggles an inline peek of that question's full verbatim response and note.
- **Expanded State (Compact Full Q&A)**:
  - Render all questions (`13px font-semibold text-neutral-100`) and full verbatim answers (`13px text-neutral-300`) with tight vertical rhythm (`px-3.5 py-3 space-y-3`), showing checkmarks for multi-select answers, a subtle `✦ Recommended` indicator when applicable, and any attached `Note: {noteText}` below the answer.

---

## Payload Contract Between Ask Tool & Transcript Card

```ts
export interface AskOption {
  id: string;
  label: string;
  shortSummary: string; // Used in the collapsed Q&A digest row
  isRecommended?: boolean;
  recommendationReason?: string;
}

export interface AskQuestionItem {
  id: string;
  question: string;
  mode: 'single' | 'multi';
  options: AskOption[];
}

export interface AnsweredQuestionRecord {
  questionId: string;
  selectedOptionIds: string[];
  notesByOptionId: Record<string, string>; // Keyed by optionId, populated via 'N' shortcut
  customText?: string; // Populated when 'other' is selected
}
```
