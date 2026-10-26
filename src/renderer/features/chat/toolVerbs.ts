import {
  BookOpen,
  Braces,
  Bug,
  Database,
  FilePlus,
  FileText,
  FolderSearch,
  GitPullRequest,
  Globe,
  Hourglass,
  Image,
  MessageCircleQuestionMark,
  Pencil,
  Replace,
  ScanSearch,
  Terminal,
  TextSearch,
  Users,
  Waypoints,
  type LucideIcon
} from 'lucide-react'
import { toolStatusLabel, type RowStatus } from './toolStatus'

// One entry of the verb map. `icon` and `base` are absent only for `thinking`, which has no tool
// icon and never renders an incomplete status.
export interface ToolVerbEntry {
  readonly icon?: LucideIcon
  readonly running: string
  readonly done: string
  readonly base?: string
}

function entry(icon: LucideIcon, running: string, done: string, base: string): ToolVerbEntry {
  return Object.freeze({ icon, running, done, base })
}

const FIND_FILES = entry(FolderSearch, 'Finding files', 'Found files', 'Find files')

// Issue #1208 (spec 022) and #469 (spec 023 FR-002, FR-003): the one sentence-case verb and icon
// map for tool and thought labels, shared by the tool rows, the thought run row, the live
// announcement, the icon tooltip and `ToolIcon`. There is no second map.
export const TOOL_VERBS: Readonly<Record<string, ToolVerbEntry>> = Object.freeze({
  read: entry(FileText, 'Reading', 'Read', 'Read'),
  edit: entry(Pencil, 'Editing', 'Edited', 'Edit'),
  write: entry(FilePlus, 'Writing', 'Wrote', 'Write'),
  bash: entry(Terminal, 'Running', 'Ran', 'Run'),
  eval: entry(Braces, 'Running code', 'Ran code', 'Run code'),
  grep: entry(TextSearch, 'Searching text', 'Searched text', 'Search text'),
  find: FIND_FILES,
  glob: FIND_FILES,
  ast_grep: entry(ScanSearch, 'Searching code', 'Searched code', 'Search code'),
  ast_edit: entry(Replace, 'Rewriting code', 'Rewrote code', 'Rewrite code'),
  lsp: entry(Waypoints, 'Querying code', 'Queried code', 'Query code'),
  task: entry(Users, 'Delegating', 'Delegated', 'Delegate'),
  ask: entry(MessageCircleQuestionMark, 'Asking', 'Asked', 'Ask'),
  web_search: entry(Globe, 'Searching web', 'Searched web', 'Search web'),
  github: entry(GitPullRequest, 'Querying GitHub', 'Queried GitHub', 'Query GitHub'),
  debug: entry(Bug, 'Debugging', 'Debugged', 'Debug'),
  recall: entry(Database, 'Recalling', 'Recalled', 'Recall'),
  retain: entry(Database, 'Remembering', 'Remembered', 'Remember'),
  reflect: entry(Database, 'Reflecting', 'Reflected', 'Reflect'),
  generate_image: entry(Image, 'Generating image', 'Generated image', 'Generate image'),
  wait: entry(Hourglass, 'Waiting', 'Waited', 'Wait'),
  skill: entry(BookOpen, 'Using skill', 'Used skill', 'Use skill'),
  thinking: Object.freeze({ running: 'Thinking', done: 'Thought process' })
})

// `Object.hasOwn`, not `in`, so a prototype key such as `toString` is never an entry.
export function toolVerbEntry(tool: string): ToolVerbEntry | undefined {
  return Object.hasOwn(TOOL_VERBS, tool) ? TOOL_VERBS[tool] : undefined
}

// FR-003: an unmapped tool id shown as itself in sentence case ("ask_user" -> "Ask user").
export function sentenceCaseToolName(tool: string): string {
  const text = tool.replace(/[_-]/g, ' ').replace(/ {2,}/g, ' ').trim()
  return text === '' ? 'Tool' : text.charAt(0).toUpperCase() + text.slice(1)
}

// Spec 023 FR-003, FR-007: the running form while running, the done form when done, and the base
// form for a call that did not complete (`error`, `exited`, `interrupted`, `cancelled`), so
// "Failed Searched text" never claims work that did not happen. Thinking has no base form and
// falls back to its done form. An unmapped tool shows its sentence-case name in every status.
export function toolVerb(tool: string, status: RowStatus): string {
  const verbs = toolVerbEntry(tool)
  if (!verbs) return sentenceCaseToolName(tool)
  if (status === 'running') return verbs.running
  if (status === 'done') return verbs.done
  return verbs.base ?? verbs.done
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
