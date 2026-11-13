# Mutation check, gate round 1 (#1867)

Mutations applied in batched builds, `cargo test --lib stack`, then restored. Run 1 mutated all rows; run 2 re-ran the cache-TTL rows after adding the refs-cache expiry test (the first run showed that guard survived); run 3 re-ran the `unavailable` guard alone.

| Guard mutated | Failing test |
|---|---|
| stacks::classify_api: `stderr.contains("HTTP 404")` -> `code != 0` (every failure reads as "no stack", fail-open) | stacks::only_a_clear_404_means_no_stack |
| stack_merge::checked_head_branch: drop `|| b.starts_with('-')` | stack_merge::head_branch_tests::a_flag_shaped_or_empty_head_branch_is_refused |
| stack_merge::route: `NotStacked | Unknown if hint_stacked` -> `Unknown if hint_stacked` | stack_merge::a_stacked_hint_wins_over_a_not_stacked_view |
| stack_merge::stack_path_allowed: drop `!unavailable &&` (run 3, alone: run 1 had it masked by the `setting_on` mutation) | stack_merge::the_stack_path_needs_toggle_available_repository_and_ready_state (line 183 `!stack_path_allowed(true, true, ..)`) |
| gh_stack_state::stack_rules_enabled: drop `setting_on &&` | gh_stack_state::stack_rules_need_the_toggle_and_a_ready_probe, and stack_merge::the_stack_path_needs_toggle_available_repository_and_ready_state |
| gh_stack_state cached_state TTL: `< STATE_TTL` -> `< Duration::MAX` (run 2, alone) | gh_stack_state::the_cached_state_expires_and_invalidate_clears_it |
| gh_stack_state::invalidate no-op (run 1, together with the other rows) | gh_stack_state::the_cached_state_expires_and_invalidate_clears_it (same test as the TTL row; not isolated) |
| stack_refs_cache invalidate no-op (run 1) | stack_refs_cache::invalidate_forces_a_refetch_and_keys_are_independent |
| stack_refs_cache TTL: `< TTL` -> `< Duration::MAX` (run 1 survived; new test added; run 2) | stack_refs_cache::an_entry_older_than_the_ttl_is_fetched_again |

Not mutated: the early returns inside the async `route_for` (setting off, no owner/repo, state not allowed). They call `gh` and have no unit seam; the decisions they delegate to (`stack_path_allowed`, `stack_rules_enabled`, `route`) are the rows above, and the live fake-gh run covers the toggle-off path.
