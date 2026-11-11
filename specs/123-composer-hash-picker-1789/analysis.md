# Analysis: spec 123 (#1789)

| Requirement | Covered by | Proof |
|---|---|---|
| FR-001, FR-002 trigger | `hashTrigger.ts` | typecheck; live check pending |
| FR-003 debounce, stale drop | `useHashPicker.ts` (250 ms debounce, `stale` flag, search key) | live check pending |
| FR-004 backend | `item_ref.rs`, `ipc/item_refs.rs` | Rust tests written; not compiled yet |
| FR-005 a11y | `HashPicker.tsx`, `useHashPicker.ts`, `MessageInput.tsx` ARIA | live check pending |
| FR-006 insert | `useHashPicker.ts` | live check pending |
| FR-007 shared look | `SlashMenu.tsx` exported classes | typecheck |
| FR-008 slash menu unchanged | `suppressed: showSlashMenu` | live check pending |

No contradictions between spec, plan and tasks. Gaps: Rust compile, `ci:local`, live check (build slot busy). Unit tests for `parseHashTrigger` and `applyHashPick` exist in `src/renderer/features/chat/hashTrigger.test.ts`.
