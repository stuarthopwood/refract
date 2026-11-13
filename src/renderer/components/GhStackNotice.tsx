// The "gh-stack is not installed / needs updating" prompt with its Install button (#1867, FR-012),
// shared by the Merge dialog (callout) and the Settings row (inline) so both read one state.
import { LayersIcon } from 'lucide-react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useGhStackStore } from '@/state/gh-stack-store'

interface GhStackNoticeProps {
  /** `callout` is a boxed alert that stays silent when nothing is wrong; `inline` always says where it stands. */
  layout: 'callout' | 'inline'
}

export function GhStackNotice({ layout }: GhStackNoticeProps) {
  const state = useGhStackStore((s) => s.state)
  const installing = useGhStackStore((s) => s.installing)
  const error = useGhStackStore((s) => s.error)
  const install = useGhStackStore((s) => s.install)
  const needsInstall = state === 'missing' || state === 'outdated'
  const headline = state === 'outdated' ? 'gh-stack needs updating.' : 'gh-stack is not installed.'
  const installButton = (
    <Button
      size="xs"
      variant="outline"
      loading={installing}
      aria-label={state === 'outdated' ? 'Install the latest gh-stack' : 'Install gh-stack'}
      onClick={() => void install()}
    >
      Install
    </Button>
  )

  if (layout === 'callout') {
    if (!needsInstall) return null
    return (
      <Alert variant="warning" data-gh-stack-notice={state}>
        <LayersIcon aria-hidden />
        <AlertTitle>{headline}</AlertTitle>
        <AlertDescription>Until then this pull request merges on its own, not together with the rest of its stack.</AlertDescription>
        {error && <AlertDescription className="text-destructive">{error}</AlertDescription>}
        <AlertActions>{installButton}</AlertActions>
      </Alert>
    )
  }

  return (
    <span className="flex flex-wrap items-center gap-2" data-gh-stack-notice={state ?? 'unknown'}>
      <span>{needsInstall ? headline : state === 'ready' ? 'gh-stack is installed and ready.' : error ?? 'Checking gh-stack…'}</span>
      {needsInstall && installButton}
      {needsInstall && error && <span role="alert" className="text-destructive">{error}</span>}
    </span>
  )
}
