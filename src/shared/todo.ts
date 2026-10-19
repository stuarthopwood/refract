// Issue #700/#701 slice (a): the wire shape of the retained todo tree (`SessionReadout.todoTree`,
// `src-tauri/src/session/readout_todo.rs`'s own `build_todo_tree`, FINDINGS item 62's live-probed
// shape: `tool_execution_end.result.details.phases` and `get_state().todoPhases` are byte-for-
// byte the same shape). A standalone module, not folded into `model.ts` (which sits at its own
// 656-line file-size cap with no headroom) -- both `model.ts`'s `SessionReadout` field and the
// renderer's shared pure derive (`features/chat/readout/todoDerive.ts`, ready for #687/#526)
// import these same two types, so the status vocabulary and shape are never declared twice.
export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned';

export interface TodoTask {
  content: string;
  status: TodoTaskStatus;
  /** Present only when `status` is `'blocked'` (FINDINGS item 62: live-probed on omp 18.12.2 --
   * never present, `null`, or an empty string on any other status). */
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}
