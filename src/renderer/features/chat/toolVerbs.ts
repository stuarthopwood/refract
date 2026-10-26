import { toolStatusLabel, type RowStatus } from './toolStatus'

// Issue #1208 (spec 022 FR-002 to FR-006): the one sentence-case verb map for tool and thought
// labels, shared by the tool rows, the thought run row, the live announcement and issue #469's
// icon tooltip. A running call shows the present-tense form; every settled status the past one.
export const TOOL_VERBS: Readonly<Record<string, Readonly<{ running: string; done: string }>>> = Object.freeze({
  read: Object.freeze({ running: 'Reading', done: 'Read' }),
  edit: Object.freeze({ running: 'Editing', done: 'Edited' }),
  write: Object.freeze({ running: 'Writing', done: 'Wrote' }),
  bash: Object.freeze({ running: 'Running', done: 'Ran' }),
  grep: Object.freeze({ running: 'Searching', done: 'Searched' }),
  find: Object.freeze({ running: 'Searching', done: 'Searched' }),
  thinking: Object.freeze({ running: 'Thinking', done: 'Thought process' }),
  skill: Object.freeze({ running: 'Using skill', done: 'Used skill' })
})

// FR-003: an unmapped tool id shown as itself in sentence case ("ask_user" -> "Ask user").
export function sentenceCaseToolName(tool: string): string {
  const text = tool.replace(/[_-]/g, ' ').replace(/ {2,}/g, ' ').trim()
  return text === '' ? 'Tool' : text.charAt(0).toUpperCase() + text.slice(1)
}

// `phase` takes any `RowStatus`: `running` maps to the running form and `done` to the done form.
// A call that did not complete (`error`, `exited`, `interrupted`, `cancelled`) shows the tool name
// in sentence case, so "Failed Searched grep" never claims work that did not happen (gate a11y
// Medium). `Object.hasOwn`, not `in`, so a prototype key such as `toString` falls through.
export function toolVerb(tool: string, phase: RowStatus): string {
  if (!Object.hasOwn(TOOL_VERBS, tool) || (phase !== 'running' && phase !== 'done')) return sentenceCaseToolName(tool)
  const verbs = TOOL_VERBS[tool]!
  return phase === 'running' ? verbs.running : verbs.done
}

// FR-006: an accessible name starts with the verb; a status word is kept as a prefix only when
// the verb alone would hide it (failed, interrupted, stopped, agent exited, or a running tool
// shown by its own name, whose label has no tense to carry "Running").
export function toolAriaPrefix(status: RowStatus, tool: string): string | undefined {
  if (status === 'done') return undefined
  if (status === 'running') return Object.hasOwn(TOOL_VERBS, tool) ? undefined : toolStatusLabel(status)
  return toolStatusLabel(status)
}

// FR-015: the live announcement for a call that just started ("Reading", or "Running mcp_fetch"
// for a tool shown by its own name).
export function toolRunningAnnouncement(tool: string): string {
  return [toolAriaPrefix('running', tool), toolVerb(tool, 'running')].filter(Boolean).join(' ')
}
