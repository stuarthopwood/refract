import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SUSPECT_WINDOW_ISSUE_URL, SUSPECT_WINDOW_LINK_LABEL, SUSPECT_WINDOWS_LINK_LABEL, suspectContextWindows, suspectWindowNote } from '@/lib/suspectContextWindow'
import type { ModelCatalogEntry } from '../../../shared/model'

/** Lists models whose base context window equals their -1m sibling's, which OMP may be misreporting. */
export function SuspectWindowsNotice({ catalog }: { catalog: readonly ModelCatalogEntry[] | undefined }) {
  const suspects = suspectContextWindows(catalog)
  if (suspects.length === 0) return null
  const single = suspects.length === 1
  return (
    <Alert variant="warning" role="note" className="mb-6">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>{single ? 'A context window may be wrong' : 'Some context windows may be wrong'}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {suspects.map((s) => (
            <li key={`${s.provider}/${s.id}`}>{suspectWindowNote(s)}</li>
          ))}
        </ul>
      </AlertDescription>
      <AlertActions>
        <Button asChild variant="link" size="xs" className="h-auto p-0 text-foreground underline underline-offset-4 hover:decoration-2">
          <a href={SUSPECT_WINDOW_ISSUE_URL} target="_blank" rel="noreferrer noopener">
            <ExternalLinkIcon aria-hidden />
            {single ? SUSPECT_WINDOW_LINK_LABEL : SUSPECT_WINDOWS_LINK_LABEL}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
      </AlertActions>
    </Alert>
  )
}