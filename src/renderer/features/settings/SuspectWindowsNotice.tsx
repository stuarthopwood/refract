import { TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SUSPECT_WINDOW_ISSUE_URL, suspectContextWindows, suspectWindowNote } from '@/lib/suspectContextWindow'
import type { ModelCatalogEntry } from '../../../shared/model'

/** Lists models whose base context window equals their -1m sibling's, which OMP may be misreporting. */
export function SuspectWindowsNotice({ catalog }: { catalog: readonly ModelCatalogEntry[] | undefined }) {
  const suspects = suspectContextWindows(catalog)
  if (suspects.length === 0) return null
  return (
    <Alert variant="warning" role="note" className="mb-6">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>Suspect context windows</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {suspects.map((s) => (
            <li key={`${s.provider}/${s.id}`}>{suspectWindowNote(s)}</li>
          ))}
        </ul>
        <a className="underline underline-offset-2" href={SUSPECT_WINDOW_ISSUE_URL} target="_blank" rel="noreferrer noopener">
          oh-my-pi#17481
        </a>
      </AlertDescription>
    </Alert>
  )
}