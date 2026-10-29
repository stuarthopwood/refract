// Spec 036 T8: the role colour swatch beside a role name. Decorative (`aria-hidden`): the role's
// name already says which role it is. Only default, smol, slow and plan have a colour; every
// other role renders nothing. Class names are listed in full so Tailwind can see them.
import type { ModelRoleId } from '../../../shared/model'

const ROLE_SWATCH_CLASS: Partial<Record<ModelRoleId, string>> = {
  default: 'bg-role-default',
  smol: 'bg-role-smol',
  slow: 'bg-role-slow',
  plan: 'bg-role-plan'
}

export function RoleSwatch({ role }: { role: ModelRoleId }) {
  const colour = ROLE_SWATCH_CLASS[role]
  if (!colour) return null
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${colour}`} />
}
