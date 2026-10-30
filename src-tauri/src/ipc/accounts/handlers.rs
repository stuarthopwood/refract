// IPC handler bodies for `accounts.*` and `app.openReleaseNotes`; wire shapes and logic live in `types.rs`.

use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::github::cli::{self, GhLoginFlowEvent};
use crate::ipc::{invalid_argument, not_found, AppState, HandlerFuture};

use super::types::{AddFlowStatus, GitHubAddFlowProgress};
use super::{
    acquire_broadcast_ticket, broadcast_add_progress, finish_completed_add, map_gh_error,
    now_epoch_millis, run_github_account_mutation, MutationKind, ACTIVE_ADD_FLOWS, ADD_FLOW_SEQ,
};

pub(super) fn accounts_github_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let ticket = acquire_broadcast_ticket();
        let hosts = cli::auth_status().await.map_err(map_gh_error)?;
        let cache_cell = super::get_profile_cache(&state.data_dir)
            .await
            .map_err(super::map_io_error)?;
        let accounts = {
            let cache = cache_cell.lock().await;
            super::types::to_github_accounts(&hosts, &cache)
        };

        // The background refresh may update names/avatars, so re-read and push them.
        // Never awaited: `list()` must not block on it.
        let data_dir = state.data_dir.clone();
        let app_handle = state.app_handle.clone();
        tokio::spawn(async move {
            let Ok(cache_cell) = super::get_profile_cache(&data_dir).await else {
                return;
            };
            for entry in &hosts {
                super::refresh_profile_cache(cache_cell, &entry.host, &entry.login, false).await;
            }
            match super::read_github_accounts(&data_dir).await {
                Ok(refreshed) => super::broadcast_github_changed_if_current(ticket, &app_handle, &refreshed),
                Err(err) => log::error!(
                    "accounts: failed to re-read the GitHub account list after a background cache refresh: {}",
                    err.message
                ),
            }
        });

        Ok(serde_json::to_value(accounts).expect("GitHubAccount list is always JSON-serialisable"))
    })
}

pub(super) fn accounts_github_add_start(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        // Always github.com: only switch/signOut take an explicit host.
        // The pre-start snapshot lets the completed add find the new login.
        let hosts_before_start = cli::auth_status().await.map_err(map_gh_error)?;
        // `GhLoginFlow::start` failures are already classified `GhError`s; no extra branch needed.
        let (flow, mut events_rx) = cli::auth_login_start("github.com")
            .await
            .map_err(map_gh_error)?;

        let flow_id = format!(
            "gh-add-{}-{}",
            now_epoch_millis(),
            ADD_FLOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1
        );
        ACTIVE_ADD_FLOWS
            .lock()
            .expect("ACTIVE_ADD_FLOWS mutex poisoned")
            .insert(flow_id.clone(), flow);

        let data_dir = state.data_dir.clone();
        let app_handle = state.app_handle.clone();
        let flow_id_for_task = flow_id.clone();
        tokio::spawn(async move {
            let mut last_code = String::new();
            while let Some(event) = events_rx.recv().await {
                match event {
                    GhLoginFlowEvent::Code(code) => {
                        last_code = code;
                        broadcast_add_progress(
                            &app_handle,
                            GitHubAddFlowProgress {
                                flow_id: flow_id_for_task.clone(),
                                code: last_code.clone(),
                                status: AddFlowStatus::Waiting,
                                detail: None,
                            },
                        );
                    }
                    GhLoginFlowEvent::Exit(info) => {
                        ACTIVE_ADD_FLOWS
                            .lock()
                            .expect("ACTIVE_ADD_FLOWS mutex poisoned")
                            .remove(&flow_id_for_task);
                        let status = if info.requested {
                            AddFlowStatus::Cancelled
                        } else if info.code == Some(0) {
                            AddFlowStatus::Completed
                        } else {
                            AddFlowStatus::Failed
                        };
                        let detail = if status == AddFlowStatus::Failed {
                            info.detail
                        } else {
                            None
                        };
                        broadcast_add_progress(
                            &app_handle,
                            GitHubAddFlowProgress {
                                flow_id: flow_id_for_task.clone(),
                                code: last_code.clone(),
                                status,
                                detail,
                            },
                        );
                        if status == AddFlowStatus::Completed {
                            let ticket = acquire_broadcast_ticket();
                            finish_completed_add(data_dir, app_handle, hosts_before_start, ticket)
                                .await;
                        }
                        break;
                    }
                }
            }
        });

        Ok(serde_json::json!({ "flowId": flow_id }))
    })
}

pub(super) fn accounts_github_add_cancel(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let flow_id = match args.first().and_then(Value::as_str) {
            Some(flow_id) => flow_id.to_string(),
            None => {
                let shown = args
                    .first()
                    .map(Value::to_string)
                    .unwrap_or_else(|| "undefined".to_string());
                return Err(invalid_argument(format!(
                    "Expected a flow ID, got {shown}."
                )));
            }
        };
        let flow = ACTIVE_ADD_FLOWS
            .lock()
            .expect("ACTIVE_ADD_FLOWS mutex poisoned")
            .get(&flow_id)
            .cloned();
        if let Some(flow) = flow {
            flow.cancel().await;
        }
        Ok(Value::Null)
    })
}

fn host_login_args(args: &[Value]) -> Result<(&str, &str), crate::ipc::IpcError> {
    let host = args.first().and_then(Value::as_str);
    let login = args.get(1).and_then(Value::as_str);
    match (host, login) {
        (Some(host), Some(login)) => Ok((host, login)),
        _ => Err(invalid_argument(
            "accounts.github expects string host/login arguments",
        )),
    }
}

pub(super) fn accounts_github_switch(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (host, login) = host_login_args(&args)?;
        let accounts =
            run_github_account_mutation(&state, host, login, MutationKind::Switch).await?;
        Ok(serde_json::to_value(accounts).expect("GitHubAccount list is always JSON-serialisable"))
    })
}

pub(super) fn accounts_github_sign_out(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (host, login) = host_login_args(&args)?;
        let accounts =
            run_github_account_mutation(&state, host, login, MutationKind::SignOut).await?;
        Ok(serde_json::to_value(accounts).expect("GitHubAccount list is always JSON-serialisable"))
    })
}

pub(super) fn accounts_omp_list(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        match crate::omp::login_providers::read_omp_login_providers().await {
            Some(providers) => Ok(serde_json::to_value(providers)
                .expect("OmpLoginProvider list is always JSON-serialisable")),
            None => Err(crate::ipc::IpcError::new(
                "omp-probe-failed",
                "omp did not answer get_login_providers successfully",
            )),
        }
    })
}

// `/login` and `/logout` cannot be driven over rpc-ui, so both refuse.
// The signature is kept so a future omp version can wire them up without an API change.

pub(super) fn accounts_omp_sign_in(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        Err(crate::ipc::IpcError::new(
            "unsupported",
            "omp has no /login command available over rpc-ui (FINDINGS item 43); run omp in a terminal and use /login there.",
        ))
    })
}

pub(super) fn accounts_omp_sign_out(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        Err(crate::ipc::IpcError::new(
            "unsupported",
            "omp has no /logout command available over rpc-ui (FINDINGS item 43); sign out from omp's own interface.",
        ))
    })
}

/// No flow can start here, so there is never a dialog to resolve. Kept for forward compatibility.
pub(super) fn accounts_omp_answer(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Err(not_found("No pending accounts.omp dialog to answer.")) })
}

pub(super) fn app_open_release_notes(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let url = format!(
            "https://github.com/stuarthopwood/refract/releases/tag/v{}",
            env!("CARGO_PKG_VERSION")
        );
        open_external_safe(&url);
        Ok(Value::Null)
    })
}

/// Opens `url` in the system browser only when it parses as `https` or `http`; anything else is dropped.
/// Never logs the URL. Calls the opener free function directly, since the IPC scope gates webview calls only.
fn open_external_safe(url: &str) {
    let parsed = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => {
            log::debug!("accounts: dropped an external open request with an unparsable URL");
            return;
        }
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        log::debug!(
            "accounts: dropped an external open request with a disallowed protocol ({})",
            parsed.scheme()
        );
        return;
    }
    if let Err(err) = tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>) {
        log::warn!("accounts: failed to open the release notes URL: {err}");
    }
}
