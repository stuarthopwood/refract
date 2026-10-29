// Issue #865 (and #712): the background-agents status banner above the composer. Lists every
// running background (detached) subagent of this Session with its live elapsed time, and a
// button that opens the Agents panel focused on that agent. A single polite announcement fires
// when one settles, and its row stays a few seconds showing its final status. No pool-limit
// counter, no telemetry.
import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { StatusBanner, type StatusBannerItem } from '@/components/StatusBanner'
import type { SubagentSummary } from '../../../shared/model'
import { formatElapsed } from '../chat/formatElapsed'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { SUBAGENT_STATUS_LABEL, SubagentStatusIcon } from './subagentStatus'

const agentName = (a: SubagentSummary) => a.name ?? a.nameOrTask
const agentKey = (a: SubagentSummary) => `${a.toolCallId}:${a.specIndex}`
const ANNOUNCE_DELAY_MS = 100
const FINISHED_ROW_MS = 4000

export function BackgroundAgentsBanner({ sessionId }: { sessionId: string }) {
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const running = useMemo(() => subagents.filter((a) => a.background && a.status === 'running'), [subagents])
  const [now, setNow] = useState(() => Date.now())
  const [announcement, setAnnouncement] = useState('')
  // A settled agent keeps its row, with its final status, for FINISHED_ROW_MS before it goes.
  const [finished, setFinished] = useState<SubagentSummary[]>([])
  const previous = useRef<Set<string>>(new Set())
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])

  useEffect(() => {
    const settled = subagents.filter((a) => previous.current.has(agentKey(a)) && a.status !== 'running')
    if (settled.length > 0) {
      const later = (run: () => void, ms: number) => {
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          run()
        }, ms)
        timers.current.add(timer)
      }
      // Cleared first, then set on a later tick, so a second identical settle is announced again.
      const text = settled.map((a) => `Background agent ${agentName(a)}: ${SUBAGENT_STATUS_LABEL[a.status]}`).join('. ')
      setAnnouncement('')
      later(() => setAnnouncement(text), ANNOUNCE_DELAY_MS)
      const keys = new Set(settled.map(agentKey))
      setFinished((rows) => [...rows.filter((a) => !keys.has(agentKey(a))), ...settled])
      later(() => setFinished((rows) => rows.filter((a) => !settled.includes(a))), FINISHED_ROW_MS)
    }
    previous.current = new Set(running.map(agentKey))
  }, [subagents, running])

  const runningKeys = new Set(running.map(agentKey))
  const rows = [...running, ...finished.filter((a) => !runningKeys.has(agentKey(a)))]
  const items: StatusBannerItem[] = rows.map((a) => ({
    id: agentKey(a),
    status: <SubagentStatusIcon status={a.status} />,
    text: agentName(a),
    meta: a.status === 'running' ? formatElapsed(now - a.startedAt) : undefined,
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
