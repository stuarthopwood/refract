import * as React from 'react'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'

interface AskFormShellProps {
  children: React.ReactNode
  /** Names the card as a group; leave it off when the card has nothing to name. */
  label?: string
  /** The header text slot; a card whose own children carry the heading passes none. */
  title?: React.ReactNode
}

/** The card chrome the agent's ask forms and the Question card share. */
export function AskFormShell({ children, label, title }: AskFormShellProps) {
  return (
    <Card size="sm" role={label ? 'group' : undefined} aria-label={label}>
      {title !== undefined && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      {children}
    </Card>
  )
}
