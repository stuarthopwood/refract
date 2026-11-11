import { useFileExplorerStore, useGitChangesStore, usePinnedPanelsStore, useReadoutStore, useSessionsStore, useSubagentPanelStore, EMPTY_READOUT_ENTRY } from '@/state'
import type { ExpandableNode } from '@/state/file-explorer-store'
import type { GitChangesGroupKind } from '../../../shared/model'

export type AgentToolErrorCode = 'unknown_panel' | 'unknown_action' | 'invalid_input' | 'panel_unavailable' | 'action_failed'

/** The renderer's answer to one tool call; Rust turns `ok: false` into a tool error, never a toast. */
export type AgentToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: AgentToolErrorCode; message: string }

export interface PanelActionContext {
  sessionId: string
  /** Opens the panel without moving focus; actions call it only after their input checked out, so a rejected call opens nothing. `prepare` runs just before the pane shows the panel, for state it must not render without. */
  open(prepare?: () => void): void
  /** A file-changing action calls this after its checks and just before it changes files; `false` means Rust gave up on the call and the action must change nothing. */
  started(): Promise<boolean>
}

export type PanelActionHandler = (context: PanelActionContext, input: Record<string, unknown>) => Promise<AgentToolOutcome>

const GROUPS: GitChangesGroupKind[] = ['staged', 'changes', 'untracked']

export function fail(code: AgentToolErrorCode, message: string): AgentToolOutcome {
  return { ok: false, code, message }
}

function succeed(value: Record<string, unknown> = {}): AgentToolOutcome {
  return { ok: true, value }
}

/** Worktree-relative only: an absolute or parent-escaping path must never reach a store or IPC call. */
export function normaliseRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.replaceAll('\\', '/')
  if (path === '' || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return null
  return segments.join('/')
}

function badPath(raw: unknown): AgentToolOutcome {
  return fail('invalid_input', `path must be a non-empty Worktree-relative path without "." or ".." segments, got ${JSON.stringify(raw)}.`)
}

async function changedFile(sessionId: string, path: string): Promise<GitChangesGroupKind | null> {
  // Always reload: the git watcher only runs while the panel is mounted, so a cached snapshot may predate the agent's own edits.
  await useGitChangesStore.getState().load(sessionId)
  const snapshot = useGitChangesStore.getState().bySession[sessionId]?.snapshot
  if (!snapshot) return null
  return GROUPS.find((group) => snapshot.groups[group].some((entry) => entry.path === path)) ?? null
}

async function toggleStage(context: PanelActionContext, input: Record<string, unknown>, staging: boolean): Promise<AgentToolOutcome> {
  const path = normaliseRelativePath(input.path)
  if (!path) return badPath(input.path)
  const group = await changedFile(context.sessionId, path)
  if (!group) return fail('invalid_input', `${path} is not a changed file in this Session.`)
  if (staging && group === 'staged') return fail('invalid_input', `${path} is already staged.`)
  if (!staging && group !== 'staged') return fail('invalid_input', `${path} is not staged.`)
  // Last stop before the change: Rust refuses once it has given up on the call, and then nothing may change.
  if (!(await context.started())) return fail('action_failed', 'The call had already timed out, so nothing was changed.')
  context.open()
  const store = useGitChangesStore.getState()
  // The reply does not depend on the follow-up reload, so it must not spend the call's window.
  const options = { awaitRefresh: false }
  const result = staging ? await store.stage(context.sessionId, [path], options) : await store.unstage(context.sessionId, [path], options)
  return result.ok ? succeed({ path, staged: staging }) : fail('action_failed', result.error.message)
}

function findNode(root: ExpandableNode | null | undefined, path: string): ExpandableNode | null {
  let node = root ?? null
  if (path === '') return node
  for (const segment of path.split('/')) {
    node = node?.children?.find((child) => child.path.split('/').pop() === segment) ?? null
    if (!node) return null
  }
  return node
}

async function reveal(context: PanelActionContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const path = normaliseRelativePath(input.path)
  if (!path) return badPath(input.path)
  const { sessionId } = context
  const store = useFileExplorerStore.getState
  const rootOf = (): ExpandableNode | null | undefined => store().bySession[sessionId]?.root
  if (!rootOf()) await store().loadDirectory(sessionId, '')
  if (!rootOf()) return fail('action_failed', 'The file tree could not be loaded.')
  const segments = path.split('/')
  // Expand each ancestor in turn: a folder's children are only fetched once it is first opened.
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join('/')
    let node = findNode(rootOf(), ancestor)
    if (!node || node.kind !== 'folder') return fail('invalid_input', `${path} does not exist in the Worktree.`)
    if (node.children === undefined) {
      await store().loadDirectory(sessionId, ancestor)
      node = findNode(rootOf(), ancestor)
    }
    if (node && !node.expanded) store().toggleExpanded(sessionId, ancestor)
  }
  const target = findNode(rootOf(), path)
  if (!target) return fail('invalid_input', `${path} does not exist in the Worktree.`)
  context.open()
  store().setSelectedPath(sessionId, path)
  if (target.kind === 'file') void store().loadPreview(sessionId, path)
  return succeed({ path, kind: target.kind })
}

async function selectAgent(context: PanelActionContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const agentId = input.agentId
  if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input', 'agentId must be a non-empty string.')
  const agents = (useReadoutStore.getState().bySession[context.sessionId] ?? EMPTY_READOUT_ENTRY).subagents
  if (!agents.some((agent) => agent.id === agentId)) return fail('invalid_input', `No Subagent ${agentId} in this Session.`)
  context.open()
  // Selected after opening and without `selectSubagentId`, which would queue a row focus; silent so a failed fetch is a tool error, not a toast.
  const error = await useSubagentPanelStore.getState().selectSubagent(agentId, undefined, { silent: true })
  if (error) return fail('action_failed', error)
  return succeed({ agentId })
}

async function openPullRequest(context: PanelActionContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const number = input.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return fail('invalid_input', 'number must be a positive integer.')
  const repositoryId = useSessionsStore.getState().sessions.find((session) => session.id === context.sessionId)?.repositoryId
  if (!repositoryId) return fail('panel_unavailable', 'This Session has no Project, so it has no pull requests to open.')
  context.open(() => usePinnedPanelsStore.getState().pin('pull-request', { repositoryId, number, sessionId: context.sessionId, focus: false }))
  return succeed({ number })
}

export async function showFile(context: PanelActionContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const path = normaliseRelativePath(input.path)
  if (!path) return badPath(input.path)
  if (!(await changedFile(context.sessionId, path))) return fail('invalid_input', `${path} is not a changed file in this Session.`)
  context.open()
  useGitChangesStore.getState().requestShowFile(context.sessionId, path)
  return succeed({ path })
}

/** Keyed `panelId` then action name; the contract JSON owns which names exist and Rust has already checked the input shape. */
export const PANEL_ACTION_HANDLERS: Record<string, Record<string, PanelActionHandler>> = {
  'git-changes': {
    show_file: showFile,
    stage_file: (context, input) => toggleStage(context, input, true),
    unstage_file: (context, input) => toggleStage(context, input, false)
  },
  'file-explorer': { reveal },
  subagents: { select_agent: selectAgent },
  'pull-request': { open_pull_request: openPullRequest },
  'side-chat': {
    open: (context) => {
      context.open()
      return Promise.resolve(succeed())
    }
  }
}
