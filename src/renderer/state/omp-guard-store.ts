import { toast } from 'sonner'
import { create } from 'zustand'
import type { OmpGuardNotice } from '../../shared/ipc'

interface OmpGuardState {
  notice: OmpGuardNotice | null
  detailsOpen: boolean
  setDetailsOpen(open: boolean): void
}

export const useOmpGuardStore = create<OmpGuardState>((set) => ({
  notice: null,
  detailsOpen: false,
  setDetailsOpen: (detailsOpen) => set({ detailsOpen })
}))

let lastShownId = 0

function summary(notice: OmpGuardNotice): string {
  const { resets, failures, overrides } = notice
  const parts: string[] = []
  if (resets.length > 0) {
    const shown = resets
      .slice(0, 2)
      .map((r) => `${r.key} ${r.old} → ${r.new}`)
      .join(', ')
    const more = resets.length > 2 ? `, +${resets.length - 2} more` : ''
    parts.push(`Reset ${resets.length} OMP setting${resets.length === 1 ? '' : 's'}: ${shown}${more}`)
  }
  if (failures.length > 0) {
    parts.push(`${failures.length} could not be reset`)
  }
  if (overrides.length > 0) {
    parts.push(`${overrides.length} overridden by the Project`)
  }
  return parts.join('; ')
}

// One toast per guard run (#1184). The main process re-delivers the start-up notice once at the
// first launch (the window may not have been listening yet), so a notice id already shown is
// ignored. `toast.warning` goes through the shared Toaster's live region, which announces it once.
export function showOmpGuardNotice(notice: OmpGuardNotice): void {
  if (notice.id <= lastShownId) return
  lastShownId = notice.id
  useOmpGuardStore.setState({ notice })
  toast.warning(summary(notice), {
    id: `omp-guard-${notice.id}`,
    duration: Infinity,
    closeButton: true,
    action: { label: 'Details', onClick: () => useOmpGuardStore.getState().setDetailsOpen(true) }
  })
}
