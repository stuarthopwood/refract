// Issue #561: the Status line's two degraded-only health readouts, "RPC slow" and "Agent memory
// high".
import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { HourglassIcon, MemoryStickIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSessionHealthStore } from '@/state/session-health-store'
import { useSessionsStore, useSplitStore } from '@/state'
import { READOUT_ITEM_BASE_CLASS, READOUT_ITEM_INTERACTIVE_ADDITIONS } from './ReadoutItem'

const REANNOUNCE_MS = 5 * 60 * 1000

const seconds = (ms: number) => (ms / 1000).toFixed(1)
const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1)

// Text for the polite status: set on a null-to-value change for the same Session only.
const lastSpokeAt = new Map<string, number>()

function useEnterAnnouncement(measure: string, sessionId: string, value: number | null, message: (prefix: string) => string): string {
  const previous = useRef<{ sessionId: string; value: number | null }>({ sessionId, value })
  const inSplit = useSplitStore((s) => s.paneSessionIds.length > 1)
  const name = useSessionsStore((s) => s.sessions.find((candidate) => candidate.id === sessionId)?.name)
  const [text, setText] = useState('')
  useEffect(() => {
    const before = previous.current
    previous.current = { sessionId, value }
    if (before.sessionId !== sessionId) {
      setText('')
      return
    }
    if (before.value === null && value !== null) {
      const now = Date.now()
      const key = `${sessionId}:${measure}`
      if (now - (lastSpokeAt.get(key) ?? 0) >= REANNOUNCE_MS) {
        lastSpokeAt.set(key, now)
        setText(message(inSplit && name ? `${name}: ` : ''))
      }
    } else if (value === null) {
      setText('')
    }
    // `message` only reads `value`, so it is deliberately not a dependency.
  }, [sessionId, value])
  return text
}

interface HealthReadoutProps {
  value: number | null
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  dataAttr: string
  label: string
  accessibleName: string
  tooltip: string
  announcement: string
}

function HealthReadout({ value, icon: Icon, dataAttr, label, accessibleName, tooltip, announcement }: HealthReadoutProps) {
  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {value !== null && (
        <Tooltip>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <button
              type="button"
              data-slot="readout-chip"
              {...{ [dataAttr]: '' }}
              aria-label={accessibleName}
              className={cn(READOUT_ITEM_BASE_CLASS, READOUT_ITEM_INTERACTIVE_ADDITIONS)}
            >
              <Icon aria-hidden className="size-4" />
              <span aria-hidden>{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

export function RpcSlowReadout({ sessionId }: { sessionId: string }) {
  const ms = useSessionHealthStore((s) => s.bySession[sessionId]?.rpcSlowMs ?? null)
  const announcement = useEnterAnnouncement('rpc', sessionId, ms, (prefix) => `${prefix}Agent responses are slow, ${seconds(ms ?? 0)} seconds.`)
  const secs = seconds(ms ?? 0)
  return (
    <HealthReadout
      value={ms}
      icon={HourglassIcon}
      dataAttr="data-rpc-slow"
      label={`RPC slow, ${secs} s`}
      accessibleName={`RPC slow, ${secs} seconds`}
      tooltip={`Last response from the agent took ${secs} s. Clears when responses come back in under 1 s.`}
      announcement={announcement}
    />
  )
}

export function AgentMemoryReadout({ sessionId }: { sessionId: string }) {
  const bytes = useSessionHealthStore((s) => s.bySession[sessionId]?.agentMemoryBytes ?? null)
  const announcement = useEnterAnnouncement('memory', sessionId, bytes, (prefix) => `${prefix}Agent memory is high, ${gigabytes(bytes ?? 0)} gigabytes.`)
  const gb = gigabytes(bytes ?? 0)
  return (
    <HealthReadout
      value={bytes}
      icon={MemoryStickIcon}
      dataAttr="data-agent-memory"
      label={`Agent memory high, ${gb} GB`}
      accessibleName={`Agent memory high, ${gb} gigabytes`}
      tooltip={`The agent process is using ${gb} GB of memory. Clears below 1.25 GB. If memory runs low, Refract shows a notice with actions.`}
      announcement={announcement}
    />
  )
}
