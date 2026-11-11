import { useRightPaneStore, useSessionsStore, useSubagentPanelStore } from '@/state'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { focusedPaneSessionId } from '@/features/sessions/newSessionInFocusedPane'
import { ALL_PANELS, type PanelId } from './panel-registry'
import { PANEL_ACTION_HANDLERS, fail, showFile, type AgentToolOutcome, type PanelActionContext } from './agent-panel-actions'

type ToolInput = Record<string, unknown> | undefined

/** FR-016: the right pane shows the front Session only, so any other caller gets `panel_unavailable`. */
function frontSessionCheck(sessionId: string): AgentToolOutcome | null {
  return focusedPaneSessionId() === sessionId ? null : fail('panel_unavailable', 'This Session is not the front Session, so its panels are not shown.')
}

function isAvailable(sessionId: string, panelId: PanelId): boolean {
  if (focusedPaneSessionId() !== sessionId) return false
  if (panelId === 'pull-request') return Boolean(useSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.repositoryId)
  return true
}

export function listPanels(sessionId: string): AgentToolOutcome {
  const { open, openPanelIds } = useRightPaneStore.getState()
  const panels = ALL_PANELS.map((panel) => ({
    id: panel.id,
    name: panel.name,
    available: isAvailable(sessionId, panel.id),
    open: open && openPanelIds.includes(panel.id),
    actions: panel.actions.map(({ name, description, mutates, inputSchema }) => ({ name, description, mutates, inputSchema })),
    ...(panel.openInputSchema ? { openInputSchema: panel.openInputSchema } : {})
  }))
  return { ok: true, value: { panels } }
}

/** Opens without focus; announces only when this call changed what the developer sees. */
function openWithoutFocus(sessionId: string, panelId: PanelId, name: string, prepare?: () => void): void {
  const pane = useRightPaneStore.getState()
  const alreadyShown = pane.open && pane.activePanelId === panelId
  if (panelId === 'subagents') useSubagentPanelStore.getState().openPanel(sessionId)
  prepare?.()
  useRightPaneStore.getState().openPanel(panelId, { focus: false })
  if (!alreadyShown) useAgentAnnouncementStore.getState().announce(`Agent opened ${name}`)
}

function resolve(sessionId: string, panelId: unknown): { ok: true; id: PanelId; name: string } | { ok: false; outcome: AgentToolOutcome } {
  const panel = ALL_PANELS.find((candidate) => candidate.id === panelId)
  if (!panel) return { ok: false, outcome: fail('unknown_panel', `No panel ${String(panelId)}.`) }
  const notFront = frontSessionCheck(sessionId)
  if (notFront) return { ok: false, outcome: notFront }
  if (!isAvailable(sessionId, panel.id)) return { ok: false, outcome: fail('panel_unavailable', `${panel.name} is not available for this Session.`) }
  return { ok: true, id: panel.id, name: panel.name }
}

export async function openPanel(sessionId: string, panelId: unknown, input: ToolInput): Promise<AgentToolOutcome> {
  const target = resolve(sessionId, panelId)
  if (!target.ok) return target.outcome
  const panel = ALL_PANELS.find((candidate) => candidate.id === target.id)
  const given = input ?? {}
  if (!panel?.openInputSchema && Object.keys(given).length > 0) return fail('invalid_input', `${target.name} takes no open input.`)
  const context: PanelActionContext = { sessionId, open: (prepare) => openWithoutFocus(sessionId, target.id, target.name, prepare) }
  // Only Git changes declares an open input today: selecting a file is its open-time effect.
  if (target.id === 'git-changes' && given.path !== undefined) return showFile(context, given)
  context.open()
  return { ok: true, value: { panelId: target.id } }
}

export async function invokePanelAction(sessionId: string, panelId: unknown, action: unknown, input: ToolInput): Promise<AgentToolOutcome> {
  const target = resolve(sessionId, panelId)
  if (!target.ok) return target.outcome
  const handler = PANEL_ACTION_HANDLERS[target.id]?.[String(action)]
  if (!handler) return fail('unknown_action', `${target.name} has no action ${String(action)}.`)
  try {
    return await handler({ sessionId, open: (prepare) => openWithoutFocus(sessionId, target.id, target.name, prepare) }, input ?? {})
  } catch (err) {
    return fail('action_failed', err instanceof Error ? err.message : String(err))
  }
}
