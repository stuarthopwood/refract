// A standalone module, not folded into `model.ts`.
export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned';

export interface TodoTask {
  content: string;
  status: TodoTaskStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}
