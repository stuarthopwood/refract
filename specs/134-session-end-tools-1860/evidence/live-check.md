# Live check, #1860 (T021 to T023)

Script `scripts/verify-tauri-1860.mjs`, fake omp (`session-tools-1858` scenario) over CDP, scratch `REFRACT_DATA_DIR`, scratch Projects, run after the Readiness wait.

| Field | Value |
|---|---|
| Head sha | `d94b335d3fd66e091683d2f56b306ab99c264eb0` |
| dirty | `false` |
| Exe sha256 | `b040a739d43737f7033e999d92a78e0a3550c06bf923a23280ffbb9747dc578f` |
| Build | `pnpm exec tauri build --debug --no-bundle`, `CARGO_TARGET_DIR=C:/Users/shopwood/.cargo-target/refract`, from the committed tree |
| Verdict | DONE (0 failures, 32 findings) |

Cases a to g all passed: archive card and Deny (a), unarchive and the 4-live-children gate from inside and outside the parent tree (b), pause, resume and stop (c), delete card in `yolo` with re-rooting and background removal (d), self, ancestor and Personal Agent refusals (e), outside-tree card and `yolo` skip (f), the one-card archive cascade (g), and no toast on any error result.

Notes: a Session in another Project cannot see the target and gets `not_found`, so the gate case uses a caller in the same Project as the full parent. A `working` Session paused reports `pausing` (status stays `working`). `Conversation file missing: C:\scratch\session\conversation.json` is a fake-omp fixture, not a bug.

## Findings

- Seed: B is a child of A and C a child of B.
- 30 calls (six tools on self, ancestors B and A, and the Personal Agent) all returned invalid_target with no card.
- An unknown id returned not_found.
- The archive card is titled "Archive Session child-c".
- archive_session on child C raised a card; after Approve archivedAt is set.
- Deny on the archive card returned a tool error and B stayed live.
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
- ONE card titled "Archive 3 Sessions" lists all three names (radiant-beaver, child-b, child-c).
- Deny on the cascade card changed nothing: all three Sessions stay live.
- After Approve the three Sessions are archived; the result lists their 3 ids.
- Y unarchived radiant-beaver with no card.
- Y unarchived child-b with no card.
- Y unarchived child-c with no card.
- In yolo, delete_session still raised a card titled "Delete Session child-b" noting live children become roots.
- After Approve delete_session returned outcome "deleting".
- A call on the Session being deleted returned invalid_state.
- The background delete removed B's worktree (C:/Users/shopwood/AppData/Local/Temp/scratch/lane-1860/tmp/refract-1860-repo-sSE8Eg/../pinion-worktrees/refract-1860-repo-sSE8Eg/keen-kestrel) and its row.
- C, a live child of the deleted B, was re-rooted: its parent link is cleared.
- No error result raised a toast.

## Screenshots (sha256)

- `01-archive-card.png` 776c2be69bbf90868fbae6a5f34a20a8b9fbfb5d9f5c03d6678d7d2ace40abc4
- `02-archive-cascade-card.png` 4bb65efecb8e55fa7a0af73d4df0ee184a159d30a7179660ecfb1768aa6526f8
- `03-delete-card-yolo.png` 9dc9d8b0f3f236bef389c96dc771e56c43a8ff5d0019bdd43bd40359f16a9a25
- `04-after-delete.png` 0fa330d337e09e87c09f279a629f8f85a89b82add84bece6959d62e5975a36a8
