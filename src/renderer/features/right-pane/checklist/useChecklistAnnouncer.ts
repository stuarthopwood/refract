import { useEffect, useState } from 'react'
import { selectSessionChecklist, useChecklistStore, type ChecklistAnnouncement } from '@/state/checklist-store'

/** How old a line may be and still count as news; the panel mounts a moment after the update that opened it. */
export const ANNOUNCEMENT_FRESH_MS = 2000

/** What the live region shows; `serial` changes on every line so an identical sentence is read again. */
export interface AnnouncerLine {
  message: string
  serial: number
}

export const SILENT_LINE: AnnouncerLine = { message: '', serial: 0 }

/** The line after a taken announcement; unchanged when there is none or it is too old to be news. */
export function nextLine(line: AnnouncerLine, announcement: ChecklistAnnouncement | null, now: number): AnnouncerLine {
  if (announcement === null || now - announcement.at > ANNOUNCEMENT_FRESH_MS) return line
  return { message: announcement.message, serial: line.serial + 1 }
}

/** Drains the Session's announcements into a line for a mounted polite live region. */
export function useChecklistAnnouncer(sessionId: string | null): AnnouncerLine {
  const pending = useChecklistStore((state) => selectSessionChecklist(state, sessionId).announcement)
  const [line, setLine] = useState(SILENT_LINE)
  useEffect(() => {
    if (sessionId === null || pending === null) return
    // Taking is the source of truth: a repeated effect run finds nothing left to say.
    const taken = useChecklistStore.getState().takeAnnouncement(sessionId)
    if (taken !== null) setLine((previous) => nextLine(previous, taken, Date.now()))
  }, [pending, sessionId])
  return line
}
