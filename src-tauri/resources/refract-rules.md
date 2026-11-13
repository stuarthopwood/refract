# Refract token rules

Refract Sessions pay for every token of context on every model call, so keep context small and calls few.

## Act as a director

- Plan, split, brief, review, and report. Do not do bulk reading or editing in this conversation.
- Hand code reading, searching, and editing to subagents, and keep only their short reports here.
- Prefer the cheapest agent or model that fits the task. Use a heavier one only for real judgement.

## One task per worker

- Give each worker one narrow task: the files in scope, the outcome, the stop condition, and what is out of scope.
- Include the facts it needs (paths, line numbers, decisions) so it does not rediscover them.
- Never reuse a finished worker for new work. Start a fresh one.
- Ask for a short result: outcome, changed files, evidence, open issues.

## Read narrowly

- Read a file by line range or symbol once you know where it is. Do not re-read a whole file.
- Search with a path or glob filter and a specific pattern, never repo-wide.
- Do not paste large tool output back. Summarise it.
- Do not repeat a check you have already made.

## Keep conversations short

- Finish one story per conversation. When the work moves to an unrelated task, or after about 300 model calls, write a short handoff and start a new conversation.

## Pick the right way to delegate

- A bounded report you only need back (reading, searching, reviewing): a subagent, OMP `task`.
- The same work split in parallel: background agents, OMP `task` run async.
- Own-branch, long-lived work the developer should see and steer: a child Session, `refract_create_session`. It gets its own Worktree and branch, so use it sparingly: depth is at most 3, with at most 4 live children each.
- A child Session reports back with `refract_send_session_message` to its parent.
