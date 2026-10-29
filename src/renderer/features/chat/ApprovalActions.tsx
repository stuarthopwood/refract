import * as React from 'react'
import type { ChatAnswer } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { SplitButton } from '@/components/ui/split-button'
import { parseApprovalOptions } from './approvalOptions'

type Resolved = 'approved' | 'denied'

/** The approval card's footer (#1140, #496): a split Approve whose main part answers OMP's plain
 * approve option and whose "More approve options" menu holds the session item and any file or
 * folder grants the request carries, then Deny. Every answer names OMP's exact option label. */
export function ApprovalActions({
  options,
  busy,
  onAnswer
}: {
  options: readonly string[] | undefined
  busy: boolean
  onAnswer: (value: ChatAnswer, kind: Resolved, detail?: string) => void
}) {
  const parsed = React.useMemo(() => parseApprovalOptions(options), [options])
  // A frame without options (older OMP) is answered with the bare boolean, as before.
  const exact = (options?.length ?? 0) > 0
  const approveWith = (label: string) =>
    onAnswer(exact ? { approve: true, option: label } : { approve: true }, 'approved', exact && label !== parsed.plain ? label : undefined)

  // Each grant lists its own option and then, after a separator, its "Always" option, so every
  // item reads as exactly the label OMP receives.
  const hasMenu = parsed.session !== undefined || parsed.grants.length > 0
  const menu = hasMenu ? (
    <>
      {parsed.session !== undefined && (
        <DropdownMenuItem onSelect={() => approveWith(parsed.session!)}>{parsed.session}</DropdownMenuItem>
      )}
      {parsed.grants.map((grant) => (
        <DropdownMenuItem key={grant.label} onSelect={() => approveWith(grant.label)}>
          {grant.label}
        </DropdownMenuItem>
      ))}
      {parsed.grants.length > 0 && <DropdownMenuSeparator />}
      {parsed.grants.map((grant) => (
        <DropdownMenuItem key={grant.alwaysLabel} onSelect={() => approveWith(grant.alwaysLabel)}>
          {grant.alwaysLabel}
        </DropdownMenuItem>
      ))}
    </>
  ) : undefined

  return (
    <>
      <SplitButton menu={menu} menuLabel="More approve options" disabled={busy} onClick={() => approveWith(parsed.plain)}>
        {parsed.plain}
      </SplitButton>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={() => onAnswer(exact ? { approve: false, option: parsed.deny } : { approve: false }, 'denied')}
      >
        Deny
      </Button>
    </>
  )
}
