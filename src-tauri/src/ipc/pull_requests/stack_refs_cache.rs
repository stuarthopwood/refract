// Short per-repository cache of the open pull requests' stack refs (#1867): the list, the detail
// and the merge dialog all chain against it, so one fetch serves them within the TTL.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

const TTL: Duration = Duration::from_secs(20);

type Slot<T> = Arc<Mutex<Option<(Instant, Arc<T>)>>>;

/// One slot per repository. The slot's async lock is held across the fetch, so concurrent callers
/// share a single fetch instead of each starting their own.
pub struct RefsCache<T> {
    slots: StdMutex<HashMap<String, Slot<T>>>,
}

impl<T> RefsCache<T> {
    pub fn new() -> Self {
        Self {
            slots: StdMutex::new(HashMap::new()),
        }
    }

    pub async fn get_or_fetch<E, F, Fut>(&self, key: &str, fetch: F) -> Result<Arc<T>, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let slot = self
            .slots
            .lock()
            .expect("stack refs cache poisoned")
            .entry(key.to_string())
            .or_default()
            .clone();
        let mut guard = slot.lock().await;
        if let Some((at, value)) = guard.as_ref() {
            if at.elapsed() < TTL {
                return Ok(value.clone());
            }
        }
        let value = Arc::new(fetch().await?);
        *guard = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    /// Drops the slot, so a fetch already in flight cannot repopulate it with pre-mutation data.
    pub fn invalidate(&self, key: &str) {
        self.slots
            .lock()
            .expect("stack refs cache poisoned")
            .remove(key);
    }
}

pub type StackRefsCache = RefsCache<Vec<crate::github::gh_pull_requests::GhStackRefEntry>>;

static CACHE: LazyLock<StackRefsCache> = LazyLock::new(RefsCache::new);

pub fn shared() -> &'static StackRefsCache {
    &CACHE
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn fetch_counting(cache: &RefsCache<u32>, key: &str, calls: &AtomicUsize) -> u32 {
        *cache
            .get_or_fetch::<(), _, _>(key, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(7)
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn concurrent_and_repeat_reads_share_one_fetch() {
        let cache = RefsCache::new();
        let calls = AtomicUsize::new(0);
        let (a, b) = tokio::join!(
            fetch_counting(&cache, "r", &calls),
            fetch_counting(&cache, "r", &calls)
        );
        assert_eq!((a, b), (7, 7));
        fetch_counting(&cache, "r", &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidate_forces_a_refetch_and_keys_are_independent() {
        let cache = RefsCache::new();
        let calls = AtomicUsize::new(0);
        fetch_counting(&cache, "r", &calls).await;
        fetch_counting(&cache, "other", &calls).await;
        cache.invalidate("r");
        fetch_counting(&cache, "r", &calls).await;
        fetch_counting(&cache, "other", &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn an_entry_older_than_the_ttl_is_fetched_again() {
        let cache = RefsCache::new();
        let calls = AtomicUsize::new(0);
        fetch_counting(&cache, "r", &calls).await;
        let slot = cache.slots.lock().unwrap().get("r").unwrap().clone();
        if let Some((at, _)) = slot.lock().await.as_mut() {
            *at = Instant::now() - (TTL + Duration::from_secs(1));
        }
        fetch_counting(&cache, "r", &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_fetch_is_not_cached() {
        let cache: RefsCache<u32> = RefsCache::new();
        let failed = cache
            .get_or_fetch("r", || async { Err::<u32, _>("boom") })
            .await;
        assert!(failed.is_err());
        let calls = AtomicUsize::new(0);
        assert_eq!(fetch_counting_err(&cache, &calls).await, 7);
    }

    async fn fetch_counting_err(cache: &RefsCache<u32>, calls: &AtomicUsize) -> u32 {
        *cache
            .get_or_fetch::<&str, _, _>("r", || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(7)
            })
            .await
            .unwrap()
    }
}
