# Tasks: App-wide design tokens (wave 1)

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. [P] slices touch disjoint files.

- [x] **T1** [P] S1: `--radius` to 0.25rem; delete arbitrary radii in `button.tsx`, `toggle.tsx`, `select.tsx`, `toggle-group.tsx`; audit all `rounded-full` (keep functional circles, convert text pills); session-list Pull requests nav entry radius; pill padding per FR-003; design docs. FR-001 to 003.
- [x] **T2** [P] S2: non-white text weight step in `globals.css`; headings 600; `kbd.tsx` and `ChangesTab.tsx` `font-sans` to the font tokens; stale comments; typography doc. FR-004, 005.
- [x] **T3** [P] S3: shared menu item class; context menu parity; muted icons; Git file-row icons; leading radio ring; tab underline to `accent-text`; PR detail divider removed; contrast pair; settings dividers; AskCard and MergeDialog ring; spec 008 and doc wording. FR-006 to 008, 011, 014.
- [x] **T4** [P] S4: `--titlebar` token in every theme; `titlebar-surface` class; Chrome band across Session list, ChatHeader, right pane, rail, PR/Settings/Manage headers, Readiness and empty chat; native overlay colour sync; contrast check extended. FR-012.
- [x] **T5** [P] S5: probe resize grip cause; always-visible grip; hit area; states; count-tab collapse; #1270 polish items. FR-009, 010, 013.
- [x] **T6** Docs: `docs/PLAN.md` wave 1 row, `CONTEXT.md` if terms changed; design docs consistency.
- [x] **T7** Gate: `pnpm typecheck`, `pnpm check:ui-text`, `check:file-size`, `check:theme-contrast`; five-reviewer gate; fix findings.
- [x] **T8** Build slot: merge origin/main, `pnpm ci:local`, live check with screenshots in light, dark and high-contrast themes.
- [x] **T9** Open the ready PR (`feat(ui): app-wide design tokens (wave 1)`), body `Closes #N` for each issue fully done.
