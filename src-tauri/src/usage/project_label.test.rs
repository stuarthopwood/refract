// Project label matching.

use std::path::Path;

use super::*;

fn index() -> ProjectIndex {
    ProjectIndex::from_pairs([
        ("C:\\Work\\proj", "proj"),
        ("C:\\Work\\proj\\.worktrees\\feature", "proj"),
        ("D:/Other/App/", "app"),
        ("C:\\Repos\\personal\\pinion-worktrees\\proj", "proj"),
        ("C:\\Repos\\personal\\pinion", "pinion"),
        ("C:\\Repos\\personal\\pinion-worktrees\\pinion", "pinion"),
    ])
}

fn label_of(idx: &ProjectIndex, cwd: &str) -> String {
    idx.label(
        Some(cwd),
        Path::new("C:\\sessions\\f\\a.jsonl"),
        Path::new("C:\\sessions"),
    )
}

fn folder_label(idx: &ProjectIndex, folder: &str) -> String {
    let file = Path::new("C:\\sessions").join(folder).join("a.jsonl");
    idx.label(None, &file, Path::new("C:\\sessions"))
}

#[test]
fn matches_a_project_its_worktree_and_subfolders_ignoring_case_and_slashes() {
    let idx = index();
    assert_eq!(idx.match_cwd("c:/work/PROJ"), Some("proj"));
    assert_eq!(idx.match_cwd("C:\\Work\\proj\\src\\deep"), Some("proj"));
    assert_eq!(
        idx.match_cwd("C:\\Work\\proj\\.worktrees\\feature\\x"),
        Some("proj")
    );
    assert_eq!(idx.match_cwd("\\\\?\\D:\\Other\\App"), Some("app"));
}

#[test]
fn a_sibling_folder_sharing_a_name_prefix_does_not_match() {
    assert_eq!(index().match_cwd("C:\\Work\\proj-two"), None);
}

#[test]
fn a_worktree_under_the_projects_worktrees_root_is_that_project() {
    let idx = index();
    assert_eq!(
        label_of(
            &idx,
            "C:\\Repos\\personal\\pinion-worktrees\\pinion\\daring-plover"
        ),
        "pinion"
    );
    assert_eq!(
        label_of(&idx, "c:/repos/personal/pinion-worktrees/pinion/gone/src"),
        "pinion"
    );
}

#[test]
fn from_registry_adds_the_worktrees_root_with_parent_dirs_resolved() {
    assert_eq!(
        resolve_dots(&normalise_path(
            "C:/Repos/personal/pinion/../pinion-worktrees/pinion"
        )),
        "c:\\repos\\personal\\pinion-worktrees\\pinion"
    );
    assert_eq!(resolve_dots("c:\\.."), "c:");
    assert_eq!(resolve_dots("\\tmp\\.\\x"), "\\tmp\\x");
}

#[test]
fn scratch_and_temp_cwds_fold_into_other() {
    let idx = index();
    assert_eq!(label_of(&idx, "C:\\tmp\\g671-r6-wt-delete"), "Other");
    assert_eq!(label_of(&idx, "c:\\TMP"), "Other");
    let temp = std::env::temp_dir().join("refract-scratch");
    assert_eq!(label_of(&idx, &temp.to_string_lossy()), "Other");
    assert_eq!(
        label_of(&idx, "C:\\Users\\SHOPWO~1\\AppData\\Local\\Temp\\x"),
        "Other"
    );
}

#[test]
fn an_unmatched_pinion_worktrees_path_is_other_even_when_nested() {
    let idx = index();
    assert_eq!(
        label_of(
            &idx,
            "C:\\Repos\\Work\\pinion-worktrees\\skippy-core\\brave-swan"
        ),
        "Other"
    );
    assert_eq!(
        label_of(
            &idx,
            "C:\\Repos\\personal\\scratch\\pinion-worktrees\\repo\\a"
        ),
        "Other"
    );
}

#[test]
fn a_project_inside_a_temp_folder_still_matches_its_project() {
    let idx = ProjectIndex::from_pairs([("C:\\tmp\\keeper", "keeper")]);
    assert_eq!(label_of(&idx, "C:\\tmp\\keeper\\src"), "keeper");
}

#[test]
fn any_other_unmatched_cwd_shows_its_folder_name() {
    let idx = index();
    assert_eq!(label_of(&idx, "C:\\Second-Brain"), "Second-Brain");
    assert_eq!(label_of(&idx, "c:/second-brain/"), "second-brain");
    assert_eq!(label_of(&idx, "C:\\Work\\proj-two"), "proj-two");
}

#[test]
fn label_falls_back_to_the_session_folder_when_there_is_no_cwd() {
    let idx = index();
    let root = Path::new("C:\\sessions");
    let file = Path::new("C:\\sessions\\enc-folder\\a.jsonl");
    assert_eq!(idx.label(None, file, root), "enc-folder");
    assert_eq!(idx.label(Some("  "), file, root), "enc-folder");
    assert_eq!(
        idx.label(None, Path::new("C:\\elsewhere\\a.jsonl"), root),
        "unknown"
    );
}

#[test]
fn encoded_folders_resolve_to_a_project_through_its_encoded_path() {
    let idx = ProjectIndex::from_pairs([
        ("C:\\Repos\\Work\\fdb.patient.activation", "fdb-pa"),
        ("C:\\Repos\\Work\\fdb-agentkit", "agentkit"),
        ("C:\\Repos\\personal\\pinion", "pinion"),
        ("C:\\Repos\\personal\\pinion-worktrees\\pinion", "pinion"),
    ]);
    assert_eq!(
        folder_label(&idx, "--C--Repos-Work-fdb.patient.activation--"),
        "fdb-pa"
    );
    assert_eq!(
        folder_label(
            &idx,
            "--C--Repos-Work-fdb.patient.activation-practice-client--"
        ),
        "fdb-pa"
    );
    assert_eq!(
        folder_label(&idx, "--C--Repos-Work-fdb-agentkit--"),
        "agentkit"
    );
    assert_eq!(
        folder_label(
            &idx,
            "--C--Repos-personal-pinion-worktrees-pinion-daring-plover--"
        ),
        "pinion"
    );
}

#[test]
fn encoded_folders_for_scratch_work_are_other_and_the_rest_keep_a_readable_name() {
    let idx = ProjectIndex::from_pairs([("C:\\Repos\\personal\\pinion", "pinion")]);
    assert_eq!(folder_label(&idx, "--C--tmp-g671-r6-wt-delete--"), "Other");
    assert_eq!(folder_label(&idx, "--C--tmp--"), "Other");
    // The Project is not registered for this worktrees folder, so it is scratch, not a subfolder.
    assert_eq!(
        folder_label(
            &idx,
            "--C--Repos-Work-pinion-worktrees-skippy-core-brave-swan--"
        ),
        "Other"
    );
    assert_eq!(
        folder_label(&idx, "--C--Repos-personal-pinion-worktrees-other-fox--"),
        "Other"
    );
    assert_eq!(folder_label(&idx, "--C--Second-Brain--"), "Second-Brain");
    assert_eq!(folder_label(&idx, "-"), "-");
}
