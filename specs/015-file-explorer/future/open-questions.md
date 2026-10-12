# Open questions carved out of spec 015 (file explorer)

Per the constitution's Incremental Enhancement rule (same pattern specs 013/014 both used): these
depend on unbuilt infrastructure or an unconfirmed Stuart preference, and do not block this spec's
P1/P2 stories. All carved out via the decision comment on
[issuecomment-6116156748](https://github.com/stuarthopwood/refract/issues/463#issuecomment-6116156748),
not re-asked here.

1. **A Settings entry for the editor command** (VS Code, VS Code Insiders, Cursor, custom).
   Issue://463's own "Open in VS Code" is hardcoded this spec; a picker is a real follow-up once
   this ships and the single-editor case is proven live.
2. **"Open in VS Code" with a line number.** Nothing in the app currently has a line number to hand
   this feature (no diff/error source is wired to it yet); revisit once one exists.
3. **Browsing OMP-owned folders** (`.omp`, rules, skills) from the tree, opt-in. Issue://463's own
   open question; the tree roots at the worktree only for this spec.
4. **"Add to prompt" (`@` mention).** Issue://463 ties this to issue://465 (`@` mentions in the
   composer), which is unbuilt (`docs/PLAN.md` still has it `todo`). Revisit once #465 ships, same
   reasoning spec 014's own item 2 used for its own "Use as context" carve-out.
5. **Search/filter box (fuzzy find-file, keyboard-first).** Issue://463's own title names "file
   preview and Open in VS Code" as the headline scope; a fuzzy-search UI and its own keyboard model
   (distinct from the tree's) is a separable enhancement, not core to that.
6. **"Open with default app" context-menu action.** A fourth near-duplicate launcher path (Open in
   VS Code, Reveal in File Explorer, and Copy path already cover the common cases) with its own
   safety surface (an arbitrary registered handler for the file's extension); a follow-up once the
   other three are proven live, not bundled into this spec's first build.
7. **A custom VS Code install location outside the three fixed roots** `research.md` decision 1
   checks. A non-standard install shows the "VS Code not found" state in this spec (Assumptions);
   a Settings override (item 1 above) would also resolve this, so it is not tracked as a separate
   gap.
