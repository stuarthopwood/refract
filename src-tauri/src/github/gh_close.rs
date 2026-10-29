// `closePullRequest` (spec 038, FR-010), split from `gh_mutations.rs` to keep that file's growth
// minimal (issue #806). The pull request id is the GraphQL node id the handler already has from
// its staleness check; a variable, never string interpolation.

use std::path::Path;

use super::gh::{gh_graphql, GhError, GraphqlValue};

pub async fn close_pull_request_mutation(
    repo_path: &Path,
    pull_request_id: &str,
) -> Result<(), GhError> {
    let query = "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { id state } } }";
    let _: serde_json::Value = gh_graphql(
        repo_path,
        query,
        &[("id", GraphqlValue::Str(pull_request_id))],
    )
    .await?;
    Ok(())
}
