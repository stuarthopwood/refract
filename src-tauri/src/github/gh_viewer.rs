// `PullRequestDetail.viewerLogin` (spec 038, FR-012): the signed-in `gh` user, so the renderer can
// tell the viewer's own comments from everyone else's. Never fails the caller -- a lookup error
// resolves to `None` and the renderer simply shows no "You" treatment.

use std::path::Path;
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::gh::gh_json;

/// Short, so switching `gh` accounts is picked up within minutes without a `gh api user` spawn
/// on every detail load.
const VIEWER_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

static VIEWER_CACHE: LazyLock<StdMutex<Option<(Instant, String)>>> =
    LazyLock::new(|| StdMutex::new(None));

#[derive(Deserialize)]
struct ViewerWire {
    login: String,
}

pub async fn viewer_login(repo_path: &Path) -> Option<String> {
    if let Some((fetched_at, login)) = VIEWER_CACHE
        .lock()
        .expect("VIEWER_CACHE mutex poisoned")
        .as_ref()
    {
        if fetched_at.elapsed() < VIEWER_CACHE_TTL {
            return Some(login.clone());
        }
    }
    let wire: ViewerWire = gh_json(repo_path, &["api", "user"]).await.ok()?;
    *VIEWER_CACHE.lock().expect("VIEWER_CACHE mutex poisoned") =
        Some((Instant::now(), wire.login.clone()));
    Some(wire.login)
}
