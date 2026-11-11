import type { AgentToolCall, AgentToolReply } from '../../../shared/ipc'
import { invokePanelAction, listPanels, openPanel } from './agent-tool-dispatch'
import type { AgentToolOutcome } from './agent-panel-actions'

function toReply(outcome: AgentToolOutcome): AgentToolReply {
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

async function dispatch(call: AgentToolCall): Promise<AgentToolOutcome> {
  const args = call.args ?? {}
  const input = args.input as Record<string, unknown> | undefined
  switch (call.tool) {
    case 'refract_list_panels':
      return listPanels(call.sessionId)
    case 'refract_open_panel':
      return openPanel(call.sessionId, args.panelId, input)
    case 'refract_invoke_panel_action':
      return invokePanelAction(call.sessionId, args.panelId, args.action, input)
    default:
      return { ok: false, code: 'action_failed', message: `Unknown tool ${String(call.tool)}.` }
  }
}

async function handleCall(call: AgentToolCall): Promise<void> {
  let reply: AgentToolReply
  try {
    reply = toReply(await dispatch(call))
  } catch (err) {
    reply = { ok: false, error: { code: 'action_failed', message: err instanceof Error ? err.message : String(err) } }
  }
  // The identity is the Session id Rust stamped on the call, never anything the agent supplied in args.
  await window.refract.agentTools.result(call.sessionId, call.callId, reply)
}

/** Subscribes once to agent tool calls; returns the unsubscribe. */
export function startAgentToolsBridge(): () => void {
  return window.refract.onAgentToolsCall((call) => {
    void handleCall(call)
  })
}
