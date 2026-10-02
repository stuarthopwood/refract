# Release & Update Requirements Quality Checklist: Installer and updates

**Purpose**: Validate `spec.md`'s own requirement quality (testable, unambiguous, consistent,
complete) before planning. This is a unit test for the requirements, not for the implementation.
**Created**: 2026-10-02
**Feature**: [spec.md](../spec.md)

**Review Ownership**: Reviewer-owned. `[x]` means the requirements-quality criterion is satisfied,
not that any code exists.

## Completeness

- [x] CHK001 Every user story has an independent test and acceptance scenarios (US1 to US5 all do).
- [x] CHK002 Every functional requirement traces to at least one user story or edge case
  (FR-001 to FR-027 each map to US1 to US5 or the Edge Cases list).
- [x] CHK003 The spec states what happens when GitHub access is unavailable or the machine is
  offline during an update check (FR-017, US3/AC7).
- [x] CHK004 The spec states what happens when a dependency install is blocked, cancelled, or
  fails (FR-010, US2/AC6).
- [x] CHK005 The spec states the uninstall default for keeping versus deleting app data (FR-023).
- [ ] CHK006 Whether the GitHub CLI is genuinely a required-for-updates dependency (and so belongs
  on the readiness checklist at all, even as optional) is flagged by the spec's own Assumptions as
  a reading that "should be confirmed with Stuart" — not yet resolved to a firm requirement.

## Clarity and measurability

- [x] CHK007 "Without administrator rights" (FR-001, FR-011) is a binary, checkable condition, not
  a vague quality word.
- [x] CHK008 "A supported 18.4.x version only" (FR-005, FR-007) is a precise, checkable version
  range, consistent with the constitution's Principle IV OMP version pin.
- [x] CHK009 SC-001 to SC-010 each give a concrete, checkable condition (a time bound, a
  percentage, or a 100%-of-cases statement) rather than an unquantified adjective.
- [ ] CHK010 SC-004 ("tell whether a newer version is available within 5 seconds") depends on a
  network round trip to GitHub through the developer's own GitHub CLI; the spec does not state
  what counts as compliant when the network itself is slow (distinct from FR-020's narrower
  startup-window guarantee, which is about local UI responsiveness, not the network call).

## Consistency

- [x] CHK011 FR-009 (manual OMP sign-in hand-off) does not conflict with FR-005/FR-006 (Install
  actions automate everything up to, but not including, sign-in).
- [x] CHK012 FR-019 (never offer pre-release, draft, same, or older version) is consistent with
  US5/AC2-AC3 (publish action excludes exactly those from being offered).
- [x] CHK013 The "no stored token" stance (FR-012's GitHub CLI dependency, Assumptions) matches the
  same stance already recorded for spec 003 FR-027, cited explicitly rather than restated
  differently.
- [x] CHK014 FR-015 ("never interrupts a running agent or turn") is consistent with the Edge Cases
  entry that cites spec 001 FR-031 (quitting already stops every agent) rather than contradicting
  it.

## Acceptance criteria quality

- [x] CHK015 US1/AC6 (upgrade in place keeps repositories, Sessions, and settings) is independently
  verifiable without relying on any other user story's acceptance criteria.
- [x] CHK016 US3/AC4-AC5 (download, verify, hold; install at next normal quit) are two separate,
  separately checkable steps rather than one compound, hard-to-isolate assertion.
- [x] CHK017 US4/AC4 (keep-or-delete-data default) states both the default path and the
  non-default path as separate, checkable outcomes.

## Edge case coverage

- [x] CHK018 Offline/slow-network behaviour during a dependency install or an update
  check/download is specified (Edge Cases, first bullet).
- [x] CHK019 A mid-download power loss (machine shuts down before the next quit) has a specified
  recovery behaviour (Edge Cases, "resumes the next time Refract quits").
- [x] CHK020 Disk-full behaviour during any of the three write-heavy operations (dependency
  install, update download, update install) is specified as "nothing is left looking installed
  when it is not" (Edge Cases).
- [x] CHK021 Concurrent install-or-uninstall while Refract is running is specified for both
  directions (Edge Cases; FR-024 for uninstall specifically).

## Non-functional requirements

- [x] CHK022 A security-relevant requirement (no stored token, FR-012/Assumptions) is present and
  is not merely implied by the update mechanism's description.
- [x] CHK023 An accessibility requirement (FR-027, keyboard operability and focus indicator for the
  update controls) is present and scoped to the controls this spec adds.

## Dependencies and assumptions

- [x] CHK024 Every cross-spec dependency (spec 001 FR-031/FR-036, spec 003 FR-027, spec 004's
  Settings screen, spec 008's profile menu) is named explicitly in Assumptions rather than left
  implicit.
- [ ] CHK025 Whether OMP's own install path (`irm https://omp.sh/install.ps1 | iex`) can pin a
  version and run unattended is explicitly logged as unverified per constitution Principle IV
  (Assumptions), and is not yet resolved — correctly left open pending the plan's first probe task.
- [x] CHK026 Code signing being out of scope (Assumptions) is distinguished from a
  [NEEDS CLARIFICATION] marker, with a stated reason (the feature can ship unsigned).

## Ambiguities and conflicts

- [x] CHK027 No functional requirement uses an unquantified term ("fast", "soon", "reasonable")
  without either a number or a pointer to the success criterion that quantifies it.
- [x] CHK028 No two requirements govern the same action with different outcomes (checked FR-004 and
  FR-022 both touch "what survives an install/uninstall" and agree: repositories, Sessions, and
  settings for an upgrade; Git, OMP, GitHub CLI, repositories, worktrees, and conversations for an
  uninstall — disjoint, non-conflicting scopes).

## Notes

- No wording defects were found in `spec.md` during this review; zero edits were made to it.
- CHK006, CHK010, and CHK025 are left unchecked because they name genuine, already-flagged open
  points (two are Stuart's own pending confirmations recorded in the spec's Assumptions; one is a
  measurability nuance worth a future spec revision) rather than blocking defects — the plan
  proceeds by making the conservative reading explicit in `research.md` per this session's
  instructions, not by editing the spec's scope.
