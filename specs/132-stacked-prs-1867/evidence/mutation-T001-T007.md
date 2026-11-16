# Mutation check #1867 (all applied at once, one run, then restored; log: mutants.log)

| Guard mutated | Failing test |
|---|---|
| gh_stack_state MIN_VERSION (0,3,0)->(0,1,0) | gh_stack_state::version_floor_is_inclusive_and_numeric |
| stacks::parse_view exit 2 -> Unknown | stacks::exit_two_is_not_stacked_and_other_failures_are_unknown |
| map_merge_failure exit 9 arm -> 8; marks_unavailable code==8 | stack_merge::exit_nine_says_plain_pull_requests_will_be_used_and_marks_the_repository |
| merge_argv drops --squash | stack_merge::stacked_argv_is_exact |
| route: Stacked(_) always Stack | stack_merge::a_view_result_beats_a_stale_hint |
| route: Unknown+hint -> Plain | stack_merge::with_no_view_the_hint_decides |
| run_route Stack=>plain, Plain=>stack | a_failed_stack_merge_never_falls_back_to_a_plain_merge, the_plain_route_never_runs_the_stack_merge |
| check_collision always Ok | stacks::a_different_stack_owning_the_number_is_refused, an_unreadable_pull_request_lookup_refuses_rather_than_guesses |
| rules content always with block | rules::stack_block_is_present_only_when_stacked, the_file_is_rewritten_when_the_toggle_flips, args::stacked_adds_the_block_without_a_second_append_flag |
| stack-chain.ts cycle `seen` guard replaced by length cap (vitest, separate run) | stack-chain.test.ts "terminates on a cycle" |
