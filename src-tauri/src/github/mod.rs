// Rust port of `src/main/github/` (pull requests, accounts, OMP sign-in, release notes, all
// through the user's own `gh` CLI, no stored token): lane R9, issue #792.
//
// `gh.rs` is `gh.ts`'s timed/resolved `gh` exec core (`GhError`/`gh_raw`/`gh_json`/`gh_graphql`/
// `owner_repo_for`) plus the shared wire primitives (`GhActor`/`GhLabel`/`GhCheckRun`);
// `gh_pull_requests.rs` (list/search/view/staleness/files) and `gh_mutations.rs` (review
// threads/timeline/comment/review/merge) are `gh.ts`'s own pull-request-management GraphQL/REST
// surface (spec 003), split from `gh.rs` to stay under the 600-line-per-file cap (issue #806).
// `cli.rs` is `cli.ts`'s account commands (`auth status`/`token`/`switch`/`logout`/the
// interactive `auth login --web` flow), which shares `gh.rs`'s own `GhError`/`gh_raw` core rather
// than duplicating it (GateCode008 MEDIUM "two gh wrappers"). `profile.rs` is `profile.ts`'s
// per-account profile/avatar fetch. `pr_lookup.rs` is `git/github.ts`'s read-only
// pull-request-for-branch lookup (serves #788's PR chip); deliberately independent of
// `gh.rs`/`cli.rs` (its own small `gh` invocation and owner/repo parse), matching the TS file's
// own doc comment that it is unmodified by the spec-003 `gh.ts` module.

pub mod cli;
pub mod copilot_plan;
pub mod gh;
pub mod gh_close;
pub mod gh_issue_list;
pub mod gh_issues;
pub mod gh_mutations;
pub mod gh_pull_requests;
pub mod gh_viewer;
pub mod images;
pub mod pr_lookup;
pub mod profile;
pub mod clone_destination;
pub mod repo_clone;
pub mod repo_list;
pub mod repo_match;
pub mod repo_ref;
