use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::agent_tools::router::DENIED;
use crate::git::test_support::init_repo;
use crate::store::registry::{RegistryStore, Repository, SessionPatch};
use crate::store::session_kind::SessionKind;

/// A change made to the registry while the approval card is open.
pub(in crate::agent_tools) enum WhileAsking {
    Remove(String),
    Add(Box<Session>),
}

/// Stands in for the running app: records every action in order and applies archive and restore
/// to a real registry, so tree rules read what a tool just wrote.
pub(in crate::agent_tools) struct FakeHost {
    pub caller: String,
    pub registry: SharedRegistry,
    pub yolo: bool,
    pub approve: bool,
    pub statuses: Mutex<HashMap<String, String>>,
    pub deleting: Mutex<HashSet<String>>,
    pub cards: Mutex<Vec<PendingRequest>>,
    pub calls: Mutex<Vec<String>>,
    pub precheck_error: Mutex<Option<(String, String)>>,
    pub while_asking: Mutex<Option<WhileAsking>>,
}

impl EndHost for FakeHost {
    fn caller_id(&self) -> &str {
        &self.caller
    }
    fn call_id(&self) -> &str {
        "call-1"
    }
    fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
    fn is_deleting(&self, id: &str) -> bool {
        self.deleting.lock().unwrap().contains(id)
    }
    async fn is_yolo(&self) -> bool {
        self.yolo
    }
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError> {
        self.cards.lock().unwrap().push(card);
        let change = self.while_asking.lock().unwrap().take();
        match change {
            Some(WhileAsking::Remove(id)) => {
                self.registry
                    .lock()
                    .await
                    .remove_session(&id)
                    .await
                    .unwrap();
            }
            Some(WhileAsking::Add(session)) => {
                self.registry
                    .lock()
                    .await
                    .add_session(*session)
                    .await
                    .unwrap();
            }
            None => {}
        }
        if self.approve {
            Ok(())
        } else {
            Err(ToolError::new(DENIED, "the developer denied this action"))
        }
    }
    async fn status(&self, id: &str) -> String {
        let statuses = self.statuses.lock().unwrap();
        statuses.get(id).cloned().unwrap_or_else(|| "idle".into())
    }
    async fn archive(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("archive:{id}"));
        self.patch_archived(id, Some("2026-02-01T00:00:00.000Z".into()))
            .await
    }
    async fn restore(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("restore:{id}"));
        let sessions = self.registry.lock().await.snapshot().sessions;
        let parent = sessions
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.parent_session_id.clone());
        if let Some(parent) = parent {
            let live = crate::store::session_tree::live_children(&sessions, &parent).count();
            if live >= crate::store::session_tree::MAX_LIVE_CHILDREN {
                return Err(ToolError::new(
                    CHILD_LIMIT,
                    "the parent has 4 live children",
                ));
            }
        }
        self.patch_archived(id, None).await
    }
    async fn stop(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("stop:{id}"));
        Ok(())
    }
    async fn pause(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("pause:{id}"));
        Ok(())
    }
    async fn resume(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("resume:{id}"));
        Ok(())
    }
    async fn delete_precheck(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("precheck:{id}"));
        match self.precheck_error.lock().unwrap().clone() {
            Some((code, message)) => Err(ToolError::new(&code, message)),
            None => Ok(()),
        }
    }
    async fn delete(&self, id: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("delete:{id}"));
        Ok(())
    }
}

impl FakeHost {
    async fn patch_archived(&self, id: &str, at: Option<String>) -> Result<(), ToolError> {
        self.registry
            .lock()
            .await
            .update_session(
                id,
                SessionPatch {
                    archived_at: Some(at),
                    ..Default::default()
                },
            )
            .await
            .map(|_| ())
            .map_err(|e| ToolError::new("registry_error", format!("{e:?}")))
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub fn card_count(&self) -> usize {
        self.cards.lock().unwrap().len()
    }
}

pub(in crate::agent_tools) fn row(id: &str, repo: &str, parent: Option<&str>) -> Session {
    Session {
        id: id.into(),
        kind: SessionKind::Project,
        repository_id: Some(repo.into()),
        name: format!("name-{id}"),
        branch: Some(id.into()),
        base_branch: Some("main".into()),
        worktree_path: Some(format!("C:/worktrees/{id}")),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        last_activity_at: "2026-01-01T00:00:00.000Z".into(),
        archived_at: None,
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: parent.map(str::to_string),
    }
}

/// A registry holding `rows` in the Projects `repo` and `elsewhere`; the caller is `me`, not in
/// `yolo`, and the developer approves.
pub(in crate::agent_tools) async fn host(rows: Vec<Session>) -> FakeHost {
    let repos = [init_repo().await, init_repo().await];
    let dir = crate::test_scratch::path(format!("refract-end-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut store = RegistryStore::open(&dir).await.unwrap();
    for (id, repo) in ["repo", "elsewhere"].into_iter().zip(&repos) {
        store
            .add_repository(Repository {
                id: id.into(),
                path: repo.to_string_lossy().into_owned(),
                name: id.into(),
                default_branch: "main".into(),
                added_at: "2026-01-01T00:00:00.000Z".into(),
                color: None,
            })
            .await
            .unwrap();
    }
    for session in rows {
        store.add_session(session).await.unwrap();
    }
    FakeHost {
        caller: "me".into(),
        registry: Arc::new(AsyncMutex::new(store)),
        yolo: false,
        approve: true,
        statuses: Mutex::new(HashMap::new()),
        deleting: Mutex::new(HashSet::new()),
        cards: Mutex::new(Vec::new()),
        calls: Mutex::new(Vec::new()),
        precheck_error: Mutex::new(None),
        while_asking: Mutex::new(None),
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, ToolError>) -> String {
    result.expect_err("expected a tool error").code
}

fn parts(card: &PendingRequest) -> (String, Vec<String>) {
    let PendingRequest::Approval {
        target, details, ..
    } = card
    else {
        panic!("expected an approval card");
    };
    (target.clone(), details.clone())
}

/// me -> kid -> grandkid, plus an unrelated root `other` and a Project `elsewhere` Session.
fn tree() -> Vec<Session> {
    vec![
        row("me", "repo", None),
        row("kid", "repo", Some("me")),
        row("grandkid", "repo", Some("kid")),
        row("other", "repo", None),
        row("foreign", "elsewhere", None),
    ]
}

#[test]
fn parse_args_reads_the_id_and_defaults_include_children_to_false() {
    let parsed = parse_args(EndTool::Stop, &json!({ "id": "kid" })).unwrap();
    assert_eq!(
        parsed,
        EndArgs {
            id: "kid".into(),
            include_children: false
        }
    );
    let cascade = parse_args(
        EndTool::Archive,
        &json!({ "id": "kid", "include_children": true }),
    )
    .unwrap();
    assert!(cascade.include_children);
}

#[test]
fn parse_args_refuses_missing_empty_and_wrong_typed_fields() {
    for args in [
        json!({}),
        json!({ "id": "" }),
        json!({ "id": "   " }),
        json!({ "id": 7 }),
        json!({ "id": null }),
        json!({ "id": "kid", "include_children": "yes" }),
        json!({ "id": "kid", "include_children": 1 }),
        json!({ "id": "kid", "extra": true }),
        json!("kid"),
    ] {
        assert_eq!(
            code(parse_args(EndTool::Archive, &args)),
            INVALID_INPUT,
            "{args}"
        );
    }
}

#[test]
fn only_archive_takes_include_children() {
    let args = json!({ "id": "kid", "include_children": true });
    for tool in EndTool::ALL.into_iter().filter(|t| *t != EndTool::Archive) {
        assert_eq!(code(parse_args(tool, &args)), INVALID_INPUT, "{tool:?}");
    }
}

#[test]
fn refuse_target_allows_a_descendant_and_an_unrelated_session() {
    let sessions = tree();
    for target in ["kid", "grandkid", "other"] {
        let row = refuse_target(&sessions, "me", target).unwrap();
        assert_eq!(row.id, target);
    }
}

#[test]
fn refuse_target_refuses_self_parent_and_grandparent() {
    let sessions = tree();
    for (caller, target) in [("kid", "kid"), ("kid", "me"), ("grandkid", "me")] {
        assert_eq!(
            code(refuse_target(&sessions, caller, target)),
            INVALID_TARGET,
            "{caller} -> {target}"
        );
    }
}

#[test]
fn refuse_target_refuses_the_personal_agent() {
    let mut personal = row("pa", "repo", None);
    personal.kind = SessionKind::Personal;
    let mut sessions = tree();
    sessions.push(personal);
    assert_eq!(code(refuse_target(&sessions, "me", "pa")), INVALID_TARGET);
}

#[test]
fn refuse_target_hides_unknown_and_other_project_sessions() {
    let sessions = tree();
    for target in ["ghost", "foreign"] {
        assert_eq!(code(refuse_target(&sessions, "me", target)), NOT_FOUND);
    }
}

#[test]
fn refuse_target_cancels_when_the_caller_is_gone() {
    assert_eq!(code(refuse_target(&tree(), "ghost", "kid")), CANCELLED);
}

#[test]
fn ancestors_stop_at_a_loop_or_a_missing_parent() {
    let sessions = tree();
    assert_eq!(ancestors_of(&sessions, "grandkid"), vec!["kid", "me"]);
    let looped = vec![
        row("a", "repo", Some("b")),
        row("b", "repo", Some("a")),
        row("c", "repo", Some("missing")),
    ];
    assert_eq!(ancestors_of(&looped, "a"), vec!["b"]);
    assert!(ancestors_of(&looped, "c").is_empty());
}

#[test]
fn needs_card_follows_the_approval_table() {
    use EndTool::*;
    // (tool, inside own tree, yolo, asks)
    let table = [
        (Archive, false, false, true),
        (Archive, true, false, true),
        (Archive, false, true, false),
        (Archive, true, true, false),
        (Stop, false, false, true),
        (Stop, true, false, true),
        (Stop, false, true, false),
        (Stop, true, true, false),
        (Pause, false, false, true),
        (Pause, true, false, false),
        (Pause, false, true, false),
        (Pause, true, true, false),
        (Resume, false, false, true),
        (Resume, true, false, false),
        (Resume, false, true, false),
        (Resume, true, true, false),
        (Unarchive, false, false, true),
        (Unarchive, true, false, false),
        (Unarchive, false, true, false),
        (Unarchive, true, true, false),
        (Delete, false, false, true),
        (Delete, true, false, true),
        (Delete, false, true, true),
        (Delete, true, true, true),
    ];
    for (tool, inside, yolo, expected) in table {
        assert_eq!(
            needs_card(tool, inside, yolo),
            expected,
            "{tool:?} inside={inside} yolo={yolo}"
        );
    }
}

#[test]
fn a_cascade_card_lists_every_session_name() {
    let names: Vec<String> = ["alpha", "beta", "gamma"].map(String::from).to_vec();
    let (title, details) = parts(&card_for(EndTool::Archive, "call-1", &names, false));
    assert_eq!(title, "Archive 3 Sessions");
    assert_eq!(details, names);
}

#[test]
fn single_card_titles_name_the_session_and_the_tool() {
    let names = vec!["alpha".to_string()];
    for (tool, title) in [
        (EndTool::Archive, "Archive Session alpha"),
        (EndTool::Unarchive, "Unarchive Session alpha"),
        (EndTool::Stop, "Stop Session alpha"),
        (EndTool::Pause, "Pause Session alpha"),
        (EndTool::Resume, "Resume Session alpha"),
    ] {
        let card = card_for(tool, "call-1", &names, false);
        assert_eq!(parts(&card), (title.to_string(), Vec::new()));
        let PendingRequest::Approval { tool: named, .. } = card else {
            panic!("expected an approval card");
        };
        assert_eq!(named, tool.name());
    }
}

#[test]
fn a_delete_card_warns_about_children_only_when_there_are_some() {
    let names = vec!["alpha".to_string()];
    let (title, plain) = parts(&card_for(EndTool::Delete, "call-1", &names, false));
    assert_eq!(title, "Delete Session alpha");
    assert_eq!(plain, vec!["Its worktree and Conversations are removed."]);
    let (_, with_children) = parts(&card_for(EndTool::Delete, "call-1", &names, true));
    assert_eq!(with_children.len(), 2);
    assert!(with_children[1].contains("become root Sessions"));
}

#[tokio::test]
async fn the_fake_host_applies_archive_and_enforces_the_live_child_limit() {
    let mut rows = vec![row("me", "repo", None)];
    for id in ["a", "b", "c", "d"] {
        rows.push(row(id, "repo", Some("me")));
    }
    let mut archived = row("old", "repo", Some("me"));
    archived.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    rows.push(archived);
    let fake = host(rows).await;
    assert_eq!(code(fake.restore("old").await), CHILD_LIMIT);
    fake.archive("a").await.unwrap();
    fake.restore("old").await.unwrap();
    assert_eq!(fake.calls(), ["restore:old", "archive:a", "restore:old"]);
}

#[test]
fn delete_errors_use_the_contract_codes() {
    use crate::ipc::IpcError;
    let missing = delete_error(IpcError::new("not-found", "Session not found: x"));
    assert_eq!(missing.code, NOT_FOUND);
    let running = delete_error(IpcError::new(
        "worktree-busy",
        "This Session is already being deleted.",
    ));
    assert_eq!(running.code, INVALID_STATE);
    let held = delete_error(IpcError::new("worktree-busy", "A program holds a file."));
    assert_eq!(held.code, DELETE_REFUSED);
}
