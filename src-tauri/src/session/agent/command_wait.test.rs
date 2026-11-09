// The queued-command wait: an already-reported list, a list that arrives mid-wait, and a timeout.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

use super::wait_until_reported;

fn reader(list: Arc<Mutex<Vec<Value>>>) -> impl FnMut() -> Pin<Box<dyn Future<Output = Vec<Value>> + Send>> {
    move || {
        let list = list.clone();
        Box::pin(async move { list.lock().await.clone() })
    }
}

#[tokio::test]
async fn an_already_reported_list_returns_without_waiting() {
    let list = Arc::new(Mutex::new(vec![json!({ "name": "todo" })]));
    let notify = Notify::new();
    let got = wait_until_reported(&notify, Duration::from_secs(5), reader(list)).await;
    assert_eq!(got, vec![json!({ "name": "todo" })]);
}

#[tokio::test]
async fn a_list_reported_mid_wait_is_returned() {
    let list = Arc::new(Mutex::new(Vec::new()));
    let notify = Arc::new(Notify::new());
    let reporter = {
        let (list, notify) = (list.clone(), notify.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            *list.lock().await = vec![json!({ "name": "usage" })];
            notify.notify_waiters();
        })
    };
    let got = wait_until_reported(&notify, Duration::from_secs(5), reader(list)).await;
    reporter.await.unwrap();
    assert_eq!(got, vec![json!({ "name": "usage" })]);
}

#[tokio::test]
async fn no_report_before_the_timeout_returns_empty() {
    let list = Arc::new(Mutex::new(Vec::new()));
    let notify = Notify::new();
    let got = wait_until_reported(&notify, Duration::from_millis(40), reader(list)).await;
    assert!(got.is_empty());
}

#[tokio::test]
async fn a_wake_with_a_still_empty_list_keeps_waiting() {
    let list = Arc::new(Mutex::new(Vec::new()));
    let notify = Arc::new(Notify::new());
    let reporter = {
        let (list, notify) = (list.clone(), notify.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            notify.notify_waiters();
            tokio::time::sleep(Duration::from_millis(20)).await;
            *list.lock().await = vec![json!({ "name": "fast" })];
            notify.notify_waiters();
        })
    };
    let got = wait_until_reported(&notify, Duration::from_secs(5), reader(list)).await;
    reporter.await.unwrap();
    assert_eq!(got, vec![json!({ "name": "fast" })]);
}
