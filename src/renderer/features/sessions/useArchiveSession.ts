// Archiving a Session that has live descendants asks first (#1862): the pure decision and dialog model,
// then the hook that owns the dialog's state. A Session with none archives at once, as it always did.
import { useRef, useState } from 'react'
import { useSessionsStore } from '@/state'
import type { Result, SessionSummary } from '../../../shared/ipc'
import { isRunning } from './sessionDisplay'
import { liveDescendants } from './sessionTree'

export interface ArchiveRunningEntry {
  id: string
  label: string
}

export interface ArchiveDialogModel {
  sessionId: string
  name: string
  /** Every live descendant at any depth: what Archive all archives. */
  total: number
  /** Live direct children: what Archive parent only leaves at the top level. */
  direct: number
  title: string
  /** Set only when nested Sessions sit below the direct children. */
  nestedLine: string | null
  /** Descendants whose agent is running, hidden ones included (marked). */
  running: ArchiveRunningEntry[]
}

export type ArchiveDecision = { kind: 'direct' } | { kind: 'confirm'; model: ArchiveDialogModel }

function sessionsText(count: number): string {
  return `${count} child Session${count === 1 ? '' : 's'}`
}

/** Two running names that read the same get their branch, so the list can tell them apart. */
function runningEntries(running: readonly SessionSummary[]): ArchiveRunningEntry[] {
  const nameCounts = new Map<string, number>()
  for (const session of running) nameCounts.set(session.name, (nameCounts.get(session.name) ?? 0) + 1)
  return running.map((session) => {
    const branch = (nameCounts.get(session.name) ?? 0) > 1 ? session.branch : null
    const label = branch ? `${session.name} (${branch})` : session.name
    return { id: session.id, label: session.hiddenAt ? `${label} (hidden)` : label }
  })
}

/**
 * Whether archiving `id` needs the dialog. `sessions` is the unfiltered store list, so a child the
 * search or the hidden filter removes from view still counts, the same set the backend archives.
 */
export function archiveDecision(sessions: readonly SessionSummary[], id: string): ArchiveDecision {
  const session = sessions.find((candidate) => candidate.id === id)
  const descendants = session ? liveDescendants(sessions, id) : []
  if (!session || descendants.length === 0) return { kind: 'direct' }
  const total = descendants.length
  const direct = descendants.filter((candidate) => candidate.parentSessionId === id).length
  const nested = total - direct
  return {
    kind: 'confirm',
    model: {
      sessionId: id,
      name: session.name,
      total,
      direct,
      title: `Archive '${session.name}' and its ${sessionsText(total)}?`,
      nestedLine: nested > 0 ? `Includes ${nested} nested Session${nested === 1 ? '' : 's'}.` : null,
      running: runningEntries(descendants.filter(isRunning))
    }
  }
}

/** The polite list announcement after a successful archive from the dialog. */
export function archiveResultMessage(model: ArchiveDialogModel, all: boolean): string {
  if (all) return `Archived ${model.name} and ${sessionsText(model.total)}`
  if (model.direct === 0) return `Archived ${model.name}`
  return `Archived ${model.name}; ${sessionsText(model.direct)} ${model.direct === 1 ? 'is' : 'are'} now at the top level`
}

export type ArchiveCall = (id: string, includeChildren?: boolean) => Promise<Result<void>>
export type ArchiveOutcome = { ok: true } | { ok: false; message: string }

/** Archive all passes `includeChildren`; Archive parent only sends the one-argument call, as every other caller does. */
export async function runArchive(call: ArchiveCall, id: string, all: boolean): Promise<ArchiveOutcome> {
  try {
    const result = all ? await call(id, true) : await call(id)
    return result.ok ? { ok: true } : { ok: false, message: result.error.message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// Called through `window.refract`, not the store's `archive`: the dialog shows a failure inline, and the
// store would send it to a toast and drop the message.
const archiveViaBridge: ArchiveCall = (id, includeChildren) =>
  includeChildren === undefined ? window.refract.sessions.archive(id) : window.refract.sessions.archive(id, includeChildren)

export interface ArchiveDialogControls {
  /** Kept through the close animation so the dialog does not blank while it fades. */
  model: ArchiveDialogModel | null
  open: boolean
  busy: boolean
  error: string | null
  choose(all: boolean): Promise<void>
  close(): void
  onCloseAutoFocus(): boolean | void
}

export interface ArchiveSessionOptions {
  announce(message: string): void
  /** Focus after the dialog closes: `archived` is true once the Session was archived. Return `false` to let Radix restore focus. */
  onClosed(archived: boolean): boolean | void
}

const ANNOUNCE_FALLBACK_MS = 600

export function useArchiveSession(sessionId: string, options: ArchiveSessionOptions) {
  const [dialog, setDialog] = useState<{ model: ArchiveDialogModel; open: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const archivedRef = useRef(false)
  // Radix keeps `#root` aria-hidden while the dialog is open, so the announcement waits for it to close.
  const pendingAnnouncementRef = useRef<string | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  /** True when the dialog opened; false means the Session has no live descendants and the caller archives it directly. */
  function request(): boolean {
    const decision = archiveDecision(useSessionsStore.getState().sessions, sessionId)
    if (decision.kind === 'direct') return false
    archivedRef.current = false
    setError(null)
    setDialog({ model: decision.model, open: true })
    return true
  }

  async function choose(all: boolean): Promise<void> {
    if (!dialog || busy) return
    const { model } = dialog
    setBusy(true)
    setError(null)
    const outcome = await runArchive(archiveViaBridge, model.sessionId, all)
    setBusy(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    archivedRef.current = true
    const message = archiveResultMessage(model, all)
    pendingAnnouncementRef.current = message
    setDialog({ model, open: false })
    // The archived row (and this hook) can unmount before Radix reports the close, which would drop the
    // announcement; the fallback speaks it once the close animation has had time to finish.
    window.setTimeout(() => {
      if (pendingAnnouncementRef.current !== message) return
      pendingAnnouncementRef.current = null
      optionsRef.current.announce(message)
    }, ANNOUNCE_FALLBACK_MS)
  }

  function close(): void {
    if (!busy) setDialog((current) => (current ? { ...current, open: false } : current))
  }

  function onCloseAutoFocus(): boolean | void {
    const archived = archivedRef.current
    archivedRef.current = false
    const message = pendingAnnouncementRef.current
    pendingAnnouncementRef.current = null
    if (message) optionsRef.current.announce(message)
    return optionsRef.current.onClosed(archived)
  }

  const controls: ArchiveDialogControls = {
    model: dialog?.model ?? null,
    open: dialog?.open ?? false,
    busy,
    error,
    choose,
    close,
    onCloseAutoFocus
  }
  return { request, controls }
}
