import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { useOmpGuardStore } from '../state/omp-guard-store'

// Lists every key the OMP settings guard touched in its last run (#1184): old → new, failures
// and Project overrides. Built from the shared Dialog primitive (ADR 0003).
export function OmpGuardDetailsDialog() {
  const notice = useOmpGuardStore((s) => s.notice)
  const open = useOmpGuardStore((s) => s.detailsOpen)
  const setOpen = useOmpGuardStore((s) => s.setDetailsOpen)
  if (!notice) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="omp-guard-details">
        <DialogHeader>
          <DialogTitle>OMP settings guard</DialogTitle>
          <DialogDescription>
            Refract reset these OMP settings to the token-cost baseline before starting OMP.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-sm">
          {notice.resets.length > 0 && (
            <section aria-label="Reset settings">
              <h3 className="font-medium">Reset</h3>
              <ul className="font-mono text-xs">
                {notice.resets.map((r) => (
                  <li key={r.key}>
                    {r.key}: {r.old} → {r.new}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notice.failures.length > 0 && (
            <section aria-label="Failed resets">
              <h3 className="font-medium">Could not reset</h3>
              <ul className="font-mono text-xs">
                {notice.failures.map((f) => (
                  <li key={f.key}>
                    {f.key}: {f.old} → {f.new} ({f.error})
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notice.overrides.length > 0 && (
            <section aria-label="Project overrides">
              <h3 className="font-medium">Overridden by the Project</h3>
              <ul className="font-mono text-xs">
                {notice.overrides.map((o) => (
                  <li key={o.key}>
                    {o.key} ({o.file}, left unchanged)
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
