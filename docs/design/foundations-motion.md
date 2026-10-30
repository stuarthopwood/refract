# Motion

This page covers functional motion rules, standard durations, the waiting indicator, the five adopted animations, caps and pause rules, reduced-motion fallbacks, and focus behaviour.

Decided by Stuart in the #474 grill, 2026-10-08.

## Functional motion

Motion always carries a function, never only decoration: every animated state keeps colour, icon, and `sr-only` text as its non-motion signal, so `prefers-reduced-motion: reduce` can remove the motion without losing information (agenda item 11). This expands the old `docs/DESIGN.md` Motion rule; it does not change it.

**Exception, Holiday touches (Stuart, 2026-10-19, #1048):** seasonal artwork and its ambient loops (snow, pumpkin flicker, sparks) are decoration by design. They are allowed only behind the Appearance setting "Holiday touches" (Full / Artwork only / Off). Loops pause when the window is hidden or unfocused, after 60 s with no input, and under OS reduced motion (WCAG 2.2.2, 2.3.3). They never flash more than three times a second, never cover text or controls, are `aria-hidden`, and never replace a functional animation's non-motion signal (the holiday spinner keeps its colour, sr-only word and reduced-motion glyph).

## Durations

- Hover and state fades: up to 150ms.
- Panel open and close: up to 200ms.

## Waiting indicator

Waiting — a wait row, "waiting on N subagents", or waiting on the user — gets an hourglass glyph plus a calm three-dot animation, and names its target in the text (for example, "Waiting for 2 subagents"). Reduced motion: a static hourglass plus the words. Busy work (a Session's agent actually working) keeps the general spinner and the brand mark, distinct from waiting.

## Adopted animations

Five animations, adopted from #566:

| # | Animation | Notes |
| --- | --- | --- |
| 1 | Fade-in for new log items | 150ms opacity plus a small rise; skipped for items from reopened history. |
| 2 | Settling completion check | About 200ms, once per completion. |
| 3 | Running-subagent shimmer | At most 3 rows shimmer at once; when more subagents run, the 3 most recently started shimmer and the rest show the static state icon. Paused when the window is hidden. Confirmed by Stuart 2026-10-08: the cap is 3, most recently started first. |
| 4 | Smooth panel collapse and expand | 200ms; never changes the chat pane's own size or scroll, matching the existing rule for the Subagent panel's collapse. |
| 5 | Streaming caret | While the answer is written; a static caret under reduced motion. |
| 6 | Status-text shimmer (#1242) | The composer status text (`CurrentWorkBanner` label) sweeps a lighter band across its accent text colour, about 1.6 s, only while the Session is working. Static in needs-you, under reduced motion or forced colours, when the window is hidden, or with Settings > Appearance "Animated status text" off. Shared utility `.text-shimmer` in `globals.css` via `ShimmerText` (colour from `--shimmer-base`, default `currentColor`; duration `--motion-shimmer-duration`); #1210 reuses it (via `CollapsedLine`'s `labelShimmer`) for exactly one transcript row: the newest running tool call, thought or Stage label, chosen once per turn in `newestRunningRow.ts`; it moves to the next running row when that one finishes and none shimmers once the turn ends, while the spinning status icon stays. Each split pane has its own banner, so several working panes can shimmer at once; row 3's "at most 3" cap does not apply here (one short line per pane). Deviation: it animates `background-position` (paint-only, one short line, no layout) because the gradient is clipped to the glyphs, so it is not transform or opacity driven. |

## Caps and pause rules

Every animation above, and any added later, follows these rules:

- Animate only `opacity` and `transform`.
- Cap the count when many agents run at once (#402).
- Pause when the window is hidden.
- Ship a reduced-motion fallback, verified by running the app with OS reduced motion on (constitution: automated tests are not required).
- Never flash.
- Give anything that runs longer than 5 seconds a pause path (WCAG 2.2.2).

## Reduced motion

Reduced motion removes all transitions and replaces every spinner with a static glyph plus the word (agenda item 11), intended to meet WCAG 2.3.3 Animation from interactions (Level AAA, adopted beyond AA; not met until the static-glyph replacement is built). Today, `globals.css`'s `prefers-reduced-motion: reduce` block collapses every animation and transition to a single 0.01ms iteration (`animation-duration`/`transition-duration: 0.01ms`, `animation-iteration-count: 1`, `scroll-behavior: auto`); replacing spinners with a static glyph is not built yet.

The **Spine** (issue #565) never animates in any state, including reduced motion (there is nothing to reduce): it is a plain CSS border that appears or disappears instantly with its group's own collapse/expand, the same way the border itself draws with no transition.

Pausing on a hidden window (Caps and pause rules above), the 3-row shimmer cap, and the `prefers-reduced-motion` OS preference are not, on their own, a user-controlled pause path for WCAG 2.2.2: none of them is a control the user can reach to stop a looping animation that is visible and running. The waiting three-dot animation, the streaming caret, `AgentSpinner` (`globals.css`, `animation-iteration-count: infinite`, issue #612, supersedes `BrandSpinner`/spec 011), every `animate-spin` icon — `Loader2Icon`/`LoaderCircleIcon` (sign-in, readiness, running tool rows, the streaming thinking row, running subagents, the New session button) — the spinning `CheckIcon` for pending PR checks (`PullRequestRow.tsx:74`, `PullRequestDetail.tsx:210`), the spinning `RefreshCwIcon` on pull-request refresh (`P…

## Focus

- Use a 2px focus-visible ring (achromatic `--ring`, **decided 2026-10-09**: not the accent token -- see "Accent and primary fill" in [foundations-tokens-theming.md](foundations-tokens-theming.md)), at least 3:1 against its surface, and never remove it.
- Return focus to the trigger after a menu or dialog closes.
- Give every hover-only action a keyboard path too.

Today's code uses a 3px ring (`focus-visible:ring-3`, `button.tsx`), not the 2px above. The 2px figure is Stuart's literal Q11 wording; the separate high-contrast decision (#552) calls its own ring "a thicker 2px focus ring", which is inconsistent with a 2px base — flagged here, not resolved, since picking new numbers is Stuart's call; `foundations-tokens-theming.md` and `accessibility.md` need the same note.

Today's focus ring token (`--ring`, an achromatic grey) is the **decided, permanent** token for this rule: Stuart ruled 2026-10-09 that the focus ring stays achromatic rather than moving to the accent token, closing the gap PR #596 had declared open (see "Accent and primary fill" in foundations-tokens-theming.md).

## Switching

Subtle enter-only motion when content changes (#678, spec 058). Tokens in `globals.css`: `--motion-fast` 100ms, `--motion-base` 150ms, `--motion-panel` 200ms, `--ease-out` `cubic-bezier(0.2, 0, 0, 1)`. Utilities are built on `tw-animate-css`; the shared hooks are `useEnterOnSwitch`, `useEnterOnAppear` and the `ValueCrossfade` component in `src/renderer/components/`.

| Surface | Utility | Motion |
|---|---|---|
| View switch (chat area, Settings, Manage sessions; the session list and rail stay still) | `motion-enter` | 150ms fade, 4px rise |
| Session switch | `motion-enter-fade` | `--motion-fade` 120ms, opacity only; pills do not also crossfade |
| Right pane opens and panel switch | `motion-enter-panel` | 200ms fade, 8px slide of the content only; the panel size and frame change instantly; closing never animates |
| Panel tab | `motion-tab-underline` | 150ms underline fade and grow in place |
| Model, reasoning, Approval pills | `motion-crossfade` | 100ms fade on change only |
| New session row (created in the last 3s only) | `motion-enter` | 150ms fade, 4px rise; restore, remount, search, archive and group expand never animate |
| Settings section | `motion-enter-fade` | 120ms fade |
| Dialogs, menus, popovers, tooltips | none added | audited onto the tokens only |

Rules:

- Enter only. Animate `opacity` and a `transform` of at most 8px; never height or width.
- Never on first paint or restore, and never replayed on re-render. The hooks key to a real content change and restart the class without remounting, so scroll restore and land-at-end (#485) are untouched.
- A switch within 150ms of the previous one skips to the final state.
- Reduced motion collapses every utility to an instant change through the global rule.
## Open

Decided (#678, 2026-10-30): the easing curve is `--ease-out` (`cubic-bezier(0.2, 0, 0, 1)`) for every enter. Still open before building the five animations above: the manual reduced-motion check for each.

Also open: the WCAG 2.2.2 pause-path mechanism for every looping animation (the waiting dots, the streaming caret, `AgentSpinner`, every `animate-spin` icon — `Loader2Icon`/`LoaderCircleIcon` (sign-in, readiness, running tool rows, the streaming thinking row, running subagents, the New session button) — the spinning `CheckIcon` for pending PR checks, and the other indicators listed above) is undecided — #566 leaves it open between a Settings control (for example, Reduce motion, stopping every looping animation on command) and relying on `prefers-reduced-motion` alone. Decide the mechanism in #566 before building. The status-text shimmer (row 6) is already covered: Settings > Appearance "Animated status text" is its pause control.
