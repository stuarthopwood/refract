# PR titles

Moved from AGENTS.md to keep agent startup context small. AGENTS.md keeps the summary rule.

## PR titles are Conventional Commits (HARD RULE)

On 2026-10-14 the repo's squash-merge was set to use the PR TITLE as the squash commit subject.
`pnpm release`'s version-bump reads every commit SUBJECT (and BODY, for a `BREAKING CHANGE`
footer) on `main`'s own mainline since the last tag; `CHANGELOG.md` generation reads merged PR
TITLES ONLY, via GitHub's own generated release notes (no PR-body/footer data is available
there). A malformed title silently breaks both the version bump and the changelog grouping.

- Format: `type(scope): subject`.
- Types: feat, fix, perf, refactor, docs, chore, test, build, ci, style. The type is matched
  case-insensitively (`Feat:`/`FEAT:`/`feat:` all count).
- A breaking change adds `!` immediately before the colon -- after the scope if there is one
  (`feat!: subject` with no scope, `feat(scope)!: subject` with one; never `feat!(scope):`) --
  no `!` usage exists yet in this repo's own history to confirm placement against, so this
  follows the standard Conventional Commits convention and `scripts/release-changelog.mjs`'s own
  parser. A `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer in the commit/PR body also bumps major,
  independent of the title. A breaking change bumps the major version.
- Scope = the PR's lane in lower case (for example `feat(r5): ...`, `fix(rm): ...`).
- `feat` bumps minor; `fix`/`perf` bump patch; every other type does not bump the version at all.
- Non-conventional/legacy titles (the old `R3: ...`-style titles already in this repo's history)
  are still accepted and land in `CHANGELOG.md`'s "Other" section verbatim, but they never bump
  the version -- a real change needing a version bump MUST use a conventional type.
- **A `BREAKING CHANGE` footer still only bumps the version, never the changelog grouping**: the
  "Breaking changes" `CHANGELOG.md` section is built from PR titles only, so a major release can
  ship with no Breaking changes section listed if the breaking PR's own title didn't also use
  `!`. Use `!` in the title too whenever a change is actually breaking.
