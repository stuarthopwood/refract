use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::omp::process::{ApprovalMode, OmpProcess, OmpProcessOptions};

/// An OMP login provider and whether it is authenticated.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLoginProvider {
    pub id: String,
    pub authenticated: bool,
}

/// Requests the provider list from a running `proc`. Any failure resolves to `None`.
pub async fn request_login_providers(proc: &OmpProcess) -> Option<Vec<OmpLoginProvider>> {
    let res = proc
        .request(serde_json::json!({ "type": "get_login_providers" }), 60_000)
        .await
        .ok()?;

    parse_login_providers_response(&res)
}

/// Parses the raw response, split out so tests need no live process.
fn parse_login_providers_response(res: &Value) -> Option<Vec<OmpLoginProvider>> {
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }

    let raw = res.get("data").and_then(|d| d.get("providers"));
    let raw = match raw.and_then(Value::as_array) {
        // A malformed `providers` field is an empty list, not a failure.
        None => return Some(Vec::new()),
        Some(arr) => arr,
    };

    let mut providers = Vec::new();
    for candidate in raw {
        if let Some(id) = candidate.get("id").and_then(Value::as_str) {
            let authenticated =
                candidate.get("authenticated").and_then(Value::as_bool) == Some(true);
            providers.push(OmpLoginProvider {
                id: id.to_string(),
                authenticated,
            });
        }
    }
    Some(providers)
}

/// Spawns a throwaway `OmpProcess` to fetch the providers. Resolves to `None` on any failure.
pub async fn read_omp_login_providers() -> Option<Vec<OmpLoginProvider>> {
    let scratch_dir = std::env::temp_dir().join(format!(
        "refract-omp-login-providers-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if tokio::fs::create_dir_all(&scratch_dir).await.is_err() {
        return None;
    }

    let opts = OmpProcessOptions {
        cwd: scratch_dir.clone(),
        approval_mode: ApprovalMode::Ask,
        omp_path: None,
        no_session: true,
        plan_mode: None,
        extra_config: None,
        stacked_prs: false,
        ready_prompt_after_ms: 30_000,
        ready_ceiling_ms: 60_000,
    };

    let result = match OmpProcess::spawn(opts).await {
        Ok(proc) => {
            let providers = request_login_providers(&proc).await;
            proc.stop().await;
            providers
        }
        Err(_) => None,
    };

    let _ = tokio::fs::remove_dir_all(&scratch_dir).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_providers() {
        let res = serde_json::json!({
            "success": true,
            "data": { "providers": [{"id": "x", "authenticated": true}] }
        });
        let providers = parse_login_providers_response(&res).unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "x");
        assert!(providers[0].authenticated);
    }

    #[test]
    fn unsuccessful_response_is_none() {
        let res = serde_json::json!({
            "success": false,
            "data": { "providers": [{"id": "x", "authenticated": true}] }
        });
        assert!(parse_login_providers_response(&res).is_none());
    }

    #[test]
    fn malformed_providers_field_is_empty_vec() {
        let res = serde_json::json!({
            "success": true,
            "data": { "providers": "not-an-array" }
        });
        assert!(parse_login_providers_response(&res).unwrap().is_empty());
    }

    #[test]
    fn provider_missing_id_is_skipped_not_a_failure() {
        let res = serde_json::json!({
            "success": true,
            "data": { "providers": [
                {"authenticated": true},
                {"id": "y", "authenticated": false}
            ] }
        });
        let providers = parse_login_providers_response(&res).unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "y");
        assert!(!providers[0].authenticated);
    }
}
