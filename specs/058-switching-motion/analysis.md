# Analysis: Switching motion (058)

Cross-check of `spec.md`, `plan.md`, `tasks.md` against the implementation.

| Requirement | Covered by | Status |
|---|---|---|
| Tokens (FR: fast, base, panel, ease-out) | `globals.css` `:root` | done |
| Utilities on tw-animate-css, no new dependency | `globals.css` `motion-*` utilities | done |
| Enter-only, opacity plus at most 8px transform | utilities (max `slide-in-from-right-2`) | done |
| Never on first paint, never on re-render | `useEnterOnSwitch` skips first render; `useEnterOnAppear` gated by list-settled flag | done |
| Rapid switch skips to final state | 150ms guard in `useEnterOnSwitch` | done |
| Session switch leaves scroll and land-at-end alone | animates the existing ChatPane root, no remount | done |
| Right pane size instant, content animates | `RightPaneShell` hooks on content only | done |
| Dialog, menu, popover, tooltip token audit, no new motion | `components/ui/*`, `menu-item-classes.ts` | done |
| Docs: Switching section, easing item closed, PLAN row | `foundations-motion.md`, `docs/PLAN.md` | done |

Findings:

- Group expand and search-filter reveals also fade rows in, because `useEnterOnAppear` cannot tell them from a new session. Accepted: still opacity and 4px, never height.
- The Health check dialog is covered by the dialog token audit; it gets no extra motion.
- File-size: `ChatPane.tsx` +2 lines at its cap check, `App.tsx` 724 of 727; the check reports 0 violations.
- No tests added (prototyping phase). Verification is the live check.
