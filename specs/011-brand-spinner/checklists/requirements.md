# Specification Quality Checklist: Brand spinner

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Requirement Clarity & Consistency

- [x] The legibility floor (24px) is defined once (Assumptions, FR-006) and used consistently
      (FR-011's "larger size" is defined relative to the same floor) rather than redefined per
      requirement
- [x] The replace/keep scope is stated once, exhaustively, with a named file:line for every item
      (FR-003, backed by research.md's inventory table) rather than a vague "other spinners are
      unaffected"
- [x] FR-010's "fixed brand colours" does not conflict with spec 007 FR-007's "every themed surface
      follows the active theme" -- the spinner is explicitly scoped out of "themed surface" by
      FR-010 itself, the same way `docs/DESIGN.md` already scopes the app icon out of the Fonts
      setting

## Acceptance Criteria Quality

- [x] Each user story's acceptance scenarios map to at least one Given/When/Then with an
      observable outcome, not an implementation step
- [x] SC-001 to SC-007 are each measurable (a grep result, a component-identity read, a time
      bound, a yes/no observable state, a pixel-identity comparison, or a rendered-alignment
      measurement) without naming a UI technology

## Edge Case Coverage

- [x] A mid-animation status change is covered (Edge Cases)
- [x] No separate in-app motion setting exists; only the OS signal is covered (Edge Cases, FR-008)
- [x] Backgrounded/minimised-window cost is covered (Edge Cases)
- [x] Scale beyond the twenty-Session measured case is covered (Edge Cases)
- [x] The forward-provisioned large size with no current host surface is covered (Edge Cases,
      Assumptions)
- [x] Windows forced-colors (high-contrast) mode is covered (Edge Cases, FR-014, SC-006)

## Dependencies & Assumptions

- [x] Dependency on the prerequisite brand assets (`build/refract-icon-v2.svg`,
      `src/renderer/assets/brand/refract-hero.svg`) being delivered by a separate change is explicit
- [x] Dependency on spec 007 (the theme presets the spinner must render unchanged under) is
      explicit
- [x] The `docs/DESIGN.md` "status bar"/"tooltips" inaccuracy (research.md decisions 11, 12) is
      corrected in the same edit that names the brand mark, not silently left for a later change
      (reversed from this spec's first draft per design review, with the reversal itself recorded)

## Notes

- Validation pass 1 (initial spec-writing for this feature): all items pass, no spec.md wording
  changes needed.
- Validation pass 2 (after `ui-architect-v3` design review, same day): FR-005/FR-006/FR-010/FR-011
  edited (opacity-only motion, a dedicated simplified path set and a fixed size ladder rather than
  a flagged full-art render); FR-014 (forced-colors) and FR-015 (optical alignment) added; SC-006
  extended and SC-007 added; the `docs/DESIGN.md` surface-list correction moved from "flagged, not
  fixed" to "fixed in the same edit" (research.md decisions 11, 12). FR-015/SC-007 are stated as
  rendered-output requirements (a measured alignment, not an assertion about the source artwork's
  own viewBox geometry, which is not in fact centred on its visual content) -- re-checked against
  "Success criteria are technology-agnostic" and "Requirements are testable and unambiguous" above,
  both still pass.
- The forward-provisioned large size (FR-011's 32px/48px rungs) is a genuine, flagged design
  decision, not a requirements-quality defect: it specifies what the component must support, while
  Assumptions and research.md decision 10 are explicit that no surface in this spec actually uses
  it yet, and name exactly how it is still verified (a temporary, unshipped harness) despite that.
