# Live check, #1860 (T021 to T023)

Script `scripts/verify-tauri-1860.mjs`, fake omp (`session-tools-1858` scenario) over CDP, scratch `REFRACT_DATA_DIR`, scratch Projects, run after the Readiness wait.

| Field | Value |
|---|---|
| Head sha | `251b7331909d21caa975211ad51824d3dfe9b802` |
| dirty | `false` |
| Exe sha256 | `c7a5462192dacb72cec3e8897c787dd8f4cdc99c1e73cc5551687910c1ca2aa2` |
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
- The archive card is titled "Archive Session abd6ab67 child-c" and shows "Below the calling Session" then "Child of child-b".
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
- ONE card titled "Archive 3 Sessions" lists all three Sessions, each ending "(Outside this Session's tree)" since caller D is not above them (94ccb8e7 silent-plover, 126c9d77 child-b, abd6ab67 child-c).
- Deny on the cascade card returned the denied error and changed nothing: all three Sessions stay live.
- The denied cascade raised no toast.
- After Approve the three Sessions are archived; the result lists their 3 ids.
- Y unarchived silent-harrier with no card.
- Y unarchived child-b with no card.
- Y unarchived child-c with no card.
- In yolo, delete_session by Y (outside B's tree) still raised ONE card titled "Delete Session 126c9d77 child-b" with "Outside this Session's tree", "Child of silent-plover", the removal line and the re-root line in order.
- After Approve delete_session returned outcome "deleting".
- The background delete removed B's worktree (C:\Users\shopwood\AppData\Local\Temp\scratch\lane-1860\tmp\refract-1860-repo-XesqRr\..\pinion-worktrees\refract-1860-repo-XesqRr\nimble-raven) and its row.
- C, a live child of the deleted B, was re-rooted: its parent link is cleared.
- A call on the deleted Session returned not_found with no card.
- No error result raised a toast: none was inserted from the first refusal to the end.

## Screenshots (sha256)

- `01-archive-card.png` 639262bbeb9a6863e5df6ee34920f8897fa78140dde6aae17bd69f292644b26b
- `02-archive-cascade-card.png` 72c4fdb0573fe077f32591c3bd21cc2c905376c8cd6820db8f892f8ebc0e7632
- `03-delete-card-yolo.png` 4b0d69bc45c3fa5d6c1e982e5a40e2828a500661ce24c386f0bf000fa62084d3
- `04-after-delete.png` c77c5e0ba06e9e7578b9bf1756402c0a09e4cd49e943e245005223fcaf58674e
