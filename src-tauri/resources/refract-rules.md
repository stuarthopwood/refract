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
