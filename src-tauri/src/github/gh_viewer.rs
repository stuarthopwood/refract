// Signed-in `gh` user for `PullRequestDetail.viewerLogin`. A lookup error resolves to `None`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::gh::gh_json;

/// Short so account switches are picked up quickly without a spawn per detail load.
const VIEWER_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

static VIEWER_CACHE: LazyLock<StdMutex<HashMap<PathBuf, (Instant, String)>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

#[derive(Deserialize)]
struct ViewerWire {
    login: String,
}

pub async fn viewer_login(repo_path: &Path) -> Option<String> {
    if let Some((fetched_at, login)) = VIEWER_CACHE
        .lock()
        .expect("VIEWER_CACHE mutex poisoned")
        .get(repo_path)
    {
        if fetched_at.elapsed() < VIEWER_CACHE_TTL {
            return Some(login.clone());
        }
    }
    let wire: ViewerWire = gh_json(repo_path, &["api", "user"]).await.ok()?;
    VIEWER_CACHE
        .lock()
        .expect("VIEWER_CACHE mutex poisoned")
        .insert(
            repo_path.to_path_buf(),
            (Instant::now(), wire.login.clone()),
        );
    Some(wire.login)
}
