// Issue #865 (and #712): the background-agents status banner above the composer. Lists every
// running background (detached) subagent of this Session with its live elapsed time, and a
// button that opens the Agents panel focused on that agent. A single polite announcement fires
// when one settles. No pool-limit counter, no telemetry.
import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { StatusBanner, type StatusBannerItem } from '@/components/StatusBanner'
import type { SubagentSummary } from '../../../shared/model'
import { formatElapsed } from '../chat/formatElapsed'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { SUBAGENT_STATUS_LABEL, SubagentStatusIcon } from './subagentStatus'

const agentName = (a: SubagentSummary) => a.name ?? a.nameOrTask
const agentKey = (a: SubagentSummary) => `${a.toolCallId}:${a.specIndex}`

export function BackgroundAgentsBanner({ sessionId }: { sessionId: string }) {
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const running = useMemo(() => subagents.filter((a) => a.background && a.status === 'running'), [subagents])
  const [now, setNow] = useState(() => Date.now())
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])

  useEffect(() => {
    const settled = subagents.filter((a) => previous.current.has(agentKey(a)) && a.status !== 'running')
    if (settled.length > 0) {
      setAnnouncement(settled.map((a) => `Background agent ${agentName(a)}: ${SUBAGENT_STATUS_LABEL[a.status]}`).join('. '))
    }
    previous.current = new Set(running.map(agentKey))
  }, [subagents, running])

  const items: StatusBannerItem[] = running.map((a) => ({
    id: agentKey(a),
    status: <SubagentStatusIcon status="running" />,
    text: agentName(a),
    meta: formatElapsed(now - a.startedAt),
    action: {
      label: 'Show',
      ariaLabel: `Show ${agentName(a)} in the Agents panel`,
      onClick: (opener) =>
        openHostedPanel('subagents', sessionId, { selectSubagentId: a.id, selectSubagentKey: agentKey(a), opener })
    }
  }))

  return (
    <>
      <StatusBanner label="Background agents" items={items} testId="background-agents-banner" />
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
