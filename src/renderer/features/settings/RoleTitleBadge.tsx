// A role's title as a badge: filled in the role colour for the four coloured roles (Default, Smol,
// Slow, Plan), neutral for the rest. The text is the role name, so colour is never the only cue.
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type { ModelRoleId } from '../../../shared/model'

const ROLE_TONE: Partial<Record<ModelRoleId, 'default' | 'smol' | 'slow' | 'plan'>> = {
  default: 'default',
  smol: 'smol',
  slow: 'slow',
  plan: 'plan'
}

export function RoleTitleBadge({ role, children }: { role: ModelRoleId; children: ReactNode }) {
  const tone = ROLE_TONE[role]
  if (!tone) return <Badge variant="secondary">{children}</Badge>
  return (
    <Badge variant="role" tone={tone}>
      {children}
    </Badge>
  )
}
