// `closePullRequest`, split from `gh_mutations.rs` (#806). The GraphQL node id is passed as a
// variable, never interpolated.

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
