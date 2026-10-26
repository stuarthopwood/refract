// Issue #687 (spec 004 FR-035 to FR-040): the one pure derive behind the current-work banner's
// line. #526's session-row status line reuses it later; neither re-derives priorities. Every
// string that came from the agent (tool `intent`, todo task text, a target path) is untrusted:
// it is reduced to plain text here, control characters stripped, and capped at
// `ACTIVITY_TEXT_MAX_CHARS`, so no consumer can render a raw one.
/** The Rust-only readout fields SessionReadout extends; all optional so older fixtures still type. All clear at the turn boundary. */
export interface ActivityReadoutFields {
  latestIntent?: string | null
  latestTool?: { name: string; target: string | null } | null
  retry?: { attempt: number; maxAttempts: number } | null
  compacting?: boolean
}

export const ACTIVITY_TEXT_MAX_CHARS = 160

export type ActivityKind = 'needs-you' | 'retrying' | 'compacting' | 'subagents' | 'todo' | 'intent' | 'tool' | 'working'

/** #526 (spec 004 FR-041): the first pending request, reduced to what the needs-you line shows. */
export type ActivityPending =
  | { kind: 'question'; text: string }
  | { kind: 'approval'; tool: string; target: string | null }

/** #526 (FR-111): the app-wide "Activity text" setting; absent reads `'plain'`. */
export type ActivityText = 'plain' | 'playful'

export interface ActivityInput {
  needsYou: boolean
  /** #526: the Session's first pending request, if known; only read when `needsYou`. */
  pending?: ActivityPending | null
  runningSubagents: number
  /** The current todo task ("n of m" is derived by the caller's todo derive); `null` when there is
   * none or the todo panel is pinned (the pinned panel already shows it, issue #687 decision 2). */
  todo: { number: number; total: number; content: string } | null
  latestIntent?: ActivityReadoutFields['latestIntent']
  latestTool?: ActivityReadoutFields['latestTool']
  retry?: ActivityReadoutFields['retry']
  compacting?: boolean
}

/** #526 (FR-109): the per-Session payload Rust pushes on `session:activity` and carries on
 * `SessionSummary.activity` -- `ActivityInput` minus the renderer-side `needsYou`/`pending`. */
export interface SessionActivity {
  runningSubagents: number
  todo: { number: number; total: number; content: string } | null
  latestIntent: string | null
  latestTool: { name: string; target: string | null } | null
  retry: { attempt: number; maxAttempts: number } | null
  compacting: boolean
}

export interface Activity {
  kind: ActivityKind
  text: string
}

/** #526 (FR-111): the Playful set, replacing only the `working` kind's "Working…". */
export const PLAYFUL_PHRASES: readonly string[] = [
  'Thinking hard…',
  'Connecting the dots…',
  'Rolling up sleeves…',
  'Piecing it together…',
  'Turning it over…',
  'Mulling it over…',
  'Following the thread…',
  'Sketching a plan…',
  'Gathering thoughts…',
  'Working the problem…',
  'Lining things up…',
  'Making progress…'
]

/** Pure: one phrase per Session (a stable hash of its id), advanced by `slot` (the 10 s tick). */
export function playfulPhrase(sessionId: string, slot: number): string {
  let hash = 0
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0
  const n = PLAYFUL_PHRASES.length
  const index = (((hash + Math.trunc(slot)) % n) + n) % n
  return PLAYFUL_PHRASES[index] ?? 'Working…'
}

// C0/C1 controls, bidi embedding/override/isolate marks, line and paragraph separators.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g

/** Plain text only: controls stripped, whitespace collapsed, capped with an ellipsis. */
export function sanitizeActivityText(raw: string, max = ACTIVITY_TEXT_MAX_CHARS): string {
  const clean = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? target
}

// A plain verb for a tool call that carried no `intent`; never the raw tool name.
const TOOL_VERBS: Record<string, [withTarget: string, without: string]> = {
  read: ['Reading', 'Reading a file'],
  edit: ['Editing', 'Editing a file'],
  write: ['Writing', 'Writing a file'],
  ast_edit: ['Editing', 'Editing code'],
  notebook: ['Editing', 'Editing a notebook']
}
const TOOL_PHRASES: Record<string, string> = {
  bash: 'Running a command',
  eval: 'Running code',
  grep: 'Searching files',
  search: 'Searching files',
  ast_grep: 'Searching code',
  find: 'Finding files',
  glob: 'Finding files',
  lsp: 'Checking code',
  task: 'Running subagents',
  todo: 'Updating the task list',
  web_search: 'Searching the web',
  fetch: 'Reading a web page',
  browser: 'Using the browser',
  ask: 'Asking a question'
}

function toolPhrase(tool: NonNullable<ActivityReadoutFields['latestTool']>): string | null {
  const verb = TOOL_VERBS[tool.name]
  if (verb) return tool.target ? `${verb[0]} ${baseName(tool.target)}` : verb[1]
  return TOOL_PHRASES[tool.name] ?? null
}

/** Priority: needs you, retrying, compacting, waiting on subagents, current todo task, latest
 * intent, a plain verb for the latest tool call, then "Working…". */
export function deriveActivity(input: ActivityInput): Activity {
  const text = (kind: ActivityKind, line: string): Activity => ({ kind, text: sanitizeActivityText(line) })
  if (input.needsYou) {
    const pending = input.pending
    if (pending?.kind === 'question' && sanitizeActivityText(pending.text)) {
      return text('needs-you', `Needs your input: ${sanitizeActivityText(pending.text)}`)
    }
    if (pending?.kind === 'approval') {
      const target = pending.target ? ` ${baseName(sanitizeActivityText(pending.target))}` : ''
      return text('needs-you', `Waiting for approval: ${sanitizeActivityText(pending.tool)}${target}`)
    }
    return text('needs-you', 'Waiting for your answer')
  }
  if (input.retry) return text('retrying', `Retrying · attempt ${input.retry.attempt} of ${input.retry.maxAttempts}`)
  if (input.compacting) return text('compacting', 'Compacting context…')
  if (input.runningSubagents > 0) {
    const n = input.runningSubagents
    return text('subagents', `Waiting for ${n} ${n === 1 ? 'subagent' : 'subagents'}`)
  }
  if (input.todo) return text('todo', `Task ${input.todo.number} of ${input.todo.total} · ${input.todo.content}`)
  const intent = input.latestIntent ? sanitizeActivityText(input.latestIntent) : ''
  if (intent) return { kind: 'intent', text: intent }
  const phrase = input.latestTool ? toolPhrase(input.latestTool) : null
  if (phrase) return text('tool', phrase)
  return text('working', 'Working…')
}
