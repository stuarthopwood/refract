# Mutation rows, gate round 1 part A

One build: all mutations applied together, `cargo test --lib -- agent_tools sessions_lifecycle approval`, each guarded test confirmed FAILED, then every mutation reverted and `cargo test --lib` run green (1138 passed before the mutation run, 0 failed).

| Guard | Mutation | Test that failed |
|---|---|---|
| Post-approval section spawned (cancel safe) | `tokio::spawn(commit_create(..)).await` replaced by `commit_create(..).await` | `dropping_the_call_mid_create_still_records_and_starts_the_session` |
| `session_limit` (before the card and under the gate) | `if live >= MAX_LIVE_SESSIONS` made `if false && ..` | `a_project_with_six_live_sessions_gets_session_limit_and_no_card`, `a_slot_taken_while_the_card_is_open_gives_session_limit_and_creates_nothing` |
| Re-check of parent under the gate | `check_tree` under the gate replaced by `None` | `a_parent_archived_while_the_card_is_open_is_invalid_input_and_creates_nothing`, `a_slot_taken_while_..` |
| First-turn parent name cleaned | `plain` returns the name unchanged | `the_parent_name_in_the_first_turn_loses_newlines_and_quotes` |
| Card line clipping | `clip_line` returns the text unchanged | `session_card_lines_are_single_line_and_capped`, `a_padded_multiline_name_cannot_push_the_card_text_off_the_card` |
| Unarchive child limit under the gate | `full` forced false | `sessions_restore_into_a_full_parent_is_child_limit_until_a_slot_frees` |

The failed-rename `warning` and the preview text have direct tests (`a_failed_rename_is_reported_as_a_warning_..`, `a_short_prompt_preview_..`); the rename warning has no separate mutation row.
