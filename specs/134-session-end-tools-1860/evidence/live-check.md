# Live check, #1860 (T021 to T023)

Script `scripts/verify-tauri-1860.mjs`, fake omp (`session-tools-1858` scenario) over CDP, scratch `REFRACT_DATA_DIR`, scratch Projects, run after the Readiness wait.

| Field | Value |
|---|---|
| Head sha | `e6d4d4a2aff0396463c381d3ef44f3e9970308f1` |
| dirty | `false` |
| Exe sha256 | `3f429af3af0f5ed4dce1b23a3a6baada95aded209ac0b348f78480241b40d969` |
| Build | `pnpm exec tauri build --debug --no-bundle`, `CARGO_TARGET_DIR=C:/Users/shopwood/.cargo-target/refract`, from the committed tree |
| Verdict | DONE (0 failures, 35 findings) |

Cases a to g all passed: archive card and Deny (a), unarchive and the 4-live-children gate from inside and outside the parent tree (b), pause, resume and stop (c), delete card in `yolo` with re-rooting and background removal (d), self, ancestor and Personal Agent refusals (e), outside-tree card and `yolo` skip (f), the one-card archive cascade (g), and no toast on any error result.

Card text is read from the approval card element (the card around the Approve button), not the page, and each Session shows its short id with its parent name or branch. Deny paths assert the `denied` code. Toasts are caught by a MutationObserver installed before the first call; a probe node proves it can see one.

Notes: a Session in another Project cannot see the target and gets `not_found`, so the gate case uses a caller in the same Project as the full parent. A `working` Session paused reports `pausing` (status stays `working`). A stop issued while a delete is in flight is not timed here; the unit test `a_delete_already_in_flight_is_invalid_state` proves `invalid_state`. `Conversation file missing: C:\scratch\session\conversation.json` is a fake-omp fixture, not a bug.

## Findings

- Seed: B is a child of A and C a child of B.
- The toast watcher saw a probe toast node, so a clean log means no toast was inserted.
- 30 calls (six tools on self, ancestors B and A, and the Personal Agent) all returned invalid_target with no card.
- An unknown id returned not_found.
- The archive card is titled "Archive Session 4cd09de9 child-c" and shows "Child of child-b".
- archive_session on child C raised a card; after Approve archivedAt is set.
- Deny on the archive card returned the denied error and B stayed live.
- The denied archive raised no toast.
- unarchive_session on descendant C raised no card and restored it.
- unarchive with 4 live children under the parent returned child_limit.
- From outside the parent tree, unarchive into a full parent returned child_limit with no approval card.
- After one child was archived, unarchive succeeded and restored only the named Session.
- pause_session on running descendant B raised no card; its pause state reads pausing.
- Pause again returned invalid_state.
- resume_session on B raised no card; B is no longer paused.
- stop_session on running Session E raised a card; after Approve E is stopped.
- Stop on a stopped Session returned session_not_running with no card.
- resume on stopped E returned session_not_running and did not start it (omp processes 13 -> 13).
- pause_session by B on unrelated D raised a card; after Approve D is paused.
- In yolo, resume of D (outside the tree) raised no card.
- In yolo, pause of D (outside the tree) raised no card and D is paused.
- D was resumed again in yolo, no card.
- ONE card titled "Archive 3 Sessions" lists all three Sessions with their short ids (d9cc9f7a silent-harrier, 07c5e949 child-b, 4cd09de9 child-c).
- Deny on the cascade card returned the denied error and changed nothing: all three Sessions stay live.
- The denied cascade raised no toast.
- After Approve the three Sessions are archived; the result lists their 3 ids.
- Y unarchived silent-harrier with no card.
- Y unarchived child-b with no card.
- Y unarchived child-c with no card.
- In yolo, delete_session still raised ONE card titled "Delete Session 07c5e949 child-b" with its parent, the removal, and the re-root line.
- After Approve delete_session returned outcome "deleting".
- The background delete removed B's worktree (C:\Users\shopwood\AppData\Local\Temp\scratch\lane-1860\tmp\refract-1860-repo-q8kuIW\..\pinion-worktrees\refract-1860-repo-q8kuIW\cosmic-lynx) and its row.
- C, a live child of the deleted B, was re-rooted: its parent link is cleared.
- A call on the deleted Session returned not_found with no card.
- No error result raised a toast: none was inserted from the first refusal to the end.

## Screenshots (sha256)

- `01-archive-card.png` cb1565b33c814180b8e26a290977968771c38578282e7165b057b6672c030f93
- `02-archive-cascade-card.png` d3850913ed37deeb97eb380b9f29312e17cd542231b89db9fb2373a103e83681
- `03-delete-card-yolo.png` d48869f32f47d55237962968f5c6f098d8b372c0e9383b7c460086d3ea31a28a
- `04-after-delete.png` 426a09e2b47d0b05ae4f0eda4a08c15b1144fe47261228143f9fa48414a43995
