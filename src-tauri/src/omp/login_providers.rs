// Port of `src/main/omp/loginProviders.ts`'s `requestLoginProviders`/`readOmpLoginProviders`.
// Drops the TS source's `sessionId: string` parameter entirely: it only ever fed
// `pidRecords.ts`, out of scope for this Rust build -- `omp::process::OmpProcessOptions` has no
// such field (see its own doc comment narrowing the field set to spawn/ready-wait/stop).

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::omp::process::{ApprovalMode, OmpProcess, OmpProcessOptions};

/// Port of `OmpLoginProvider` (`loginProviders.ts`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLoginProvider {
    pub id: String,
    pub authenticated: bool,
}

/// Runs the read-only `get_login_providers` command against an already-running `proc` and
/// returns the provider list. Never fails: any problem -- request error, unsuccessful response,
/// malformed payload -- resolves to `None` instead. Each provider's `id` is validated as a
/// string before being trusted.
pub async fn request_login_providers(proc: &OmpProcess) -> Option<Vec<OmpLoginProvider>> {
    let res = proc
        .request(serde_json::json!({ "type": "get_login_providers" }), 60_000)
        .await
        .ok()?;

    if res.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }

    let raw = res.get("data").and_then(|d| d.get("providers"));
    let raw = match raw.and_then(Value::as_array) {
        // Matches the TS source's own `!Array.isArray(raw) -> []` branch: a present-but-
        // malformed `providers` field is an empty list, not a whole-call failure.
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

/// Spins up a scratch, non-Session `OmpProcess` (temp-dir cwd, started on demand, stopped and
/// the temp dir removed when done) purely to call `request_login_providers` above, for a caller
/// with no already-running process of its own to reuse (`accounts.omp.list`'s only caller).
///
/// Never fails: resolves to `None` on any problem, including temp-dir creation or process spawn
/// failure.
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
