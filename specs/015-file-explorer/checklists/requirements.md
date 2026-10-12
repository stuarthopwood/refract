# Specification Quality Checklist: File explorer

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-12
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) in spec.md's requirements
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain -- the five genuinely open items (Settings
      editor-picker, OMP-owned folders in the tree, "Add to prompt" @ mention flow,
      search/filter, which context-menu actions ship this round beyond the three resolved) are
      carved to `future/open-questions.md` per the constitution's Incremental Enhancement rule,
      same pattern spec 013/014 used
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded (Assumptions names spec 013's shell and spec 014's per-Session
      panel-binding precedent as already built and unchanged by this feature)
- [x] Dependencies and assumptions identified

## Requirement Clarity & Consistency

- [x] FR-001 (worktree path containment) is stated once in Functional Requirements and echoed a
      second time in Edge Cases (the symlink/junction case) deliberately, since both the general
      containment rule and its trickiest escape route deserve independent, explicit coverage
- [x] FR-002/FR-003's preview-kind detection (size cap vs. binary-content sniff) is distinguished
      from FR-015's "cannot preview" rendering rule, so an implementer does not conflate
      "detecting that a file cannot be previewed" with "what the UI shows when it can't"
- [x] FR-011 (the git-status/ignore reader being a single shared main-process reader, scoped for
      reuse by the future git-changes panel, #464) is marked explicitly as built now but gated on
      no circular dependency on #464's own unbuilt scope, resolving what otherwise read as
      contradictory text between the two issues' own PLAN.md entries (Assumptions)

## Acceptance Criteria Quality

- [x] Each user story's acceptance scenarios map to at least one Given/When/Then with an
      observable outcome, not an implementation step
- [x] SC-001 to SC-006 are each measurable (a 100%-no-partial-render check, a zero-escaped-read
      check, a 100%-expansion-preservation check, a 100%-text-equivalent check, an
      install-root-success-or-clear-failure check, or a single-Tab-stop keyboard check) without
      naming a UI technology

## Edge Case Coverage

- [x] A symlink/junction resolving outside the worktree is covered (Edge Cases), tied directly to
      FR-001 and SC-002
- [x] A file deleted while its preview is open is covered (Edge Cases, User Story 5 Scenario 2)
- [x] A huge repository (many thousands of entries in one folder) is covered (Edge Cases), tied to
      `research.md` decision 7's capped-list-per-folder design rather than an unbounded render or
      a frozen UI
- [x] A binary file selected for preview is covered (Edge Cases, User Story 2 Scenario 3)
- [x] The `.gitignore` toggle (showing vs. hiding ignored paths, and `.git` itself never showing
      regardless) is covered (Edge Cases, User Story 3 Scenario 2)
- [x] A path containing git-quoted characters (non-ASCII, embedded spaces) is covered (Edge Cases),
      resolved end-to-end because every invocation in this spec uses `-z` (research.md decisions 2
      and 6), the same precedent `diffStat.ts`'s own `ls-files -z` call already establishes

## Dependencies & Assumptions

- [x] Dependency on spec 013 (the shell itself, merged #665) is explicit and scoped to exactly
      what is reused (panel registry, rail, tab bar, launcher) with no shell change required
- [x] Dependency on spec 014's per-Session panel-binding precedent is explicit, named as already
      built and unchanged by this feature
- [x] The VS Code install-root assumption (three documented default locations; a non-standard
      custom install location is out of scope, surfaced instead as the "not found" state) is
      explicit, consistent with "VS Code only, hardcoded, no picker" (Clarification item 4)
- [x] The git-status reader's reuse by the future git-changes panel (#464) is named explicitly as
      the reason it is built as a small, shared, standalone module now, resolving the apparent
      circular dependency between this spec and #464's own unbuilt scope
- [x] The `FolderTreeIcon` choice (research.md decision 8) is named explicitly as an
      implementation-level choice, not a Stuart decision, open to review the same way spec 013's
      own icon choices were
- [x] Platform assumption (Windows 11, Electron/React stack, no new runtime dependency --
      `react-virtuoso` already pinned) is explicit in plan.md's Technical Context

## Notes

- Validation pass 1 (this review, during spec drafting for this spec): all items pass, no spec.md
  wording changes needed before `/speckit.plan`.
- Five open items (Settings editor-picker, OMP-owned folders in the tree, "Add to prompt" @ mention
  flow, search/filter, and the full final context-menu-action set beyond the three resolved this
  round) are deferred per `superpowers:speckit-defer-clarification` (carved into
  `future/open-questions.md`; no needs-clarification marker string appears anywhere in this
  feature's `spec.md`, `plan.md`, or this checklist).
