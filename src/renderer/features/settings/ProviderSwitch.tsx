// Issue #1069 decision 1: one provider segmented control (ADR 0003) above the chat-role list,
// extending `ManageSessionsToolbar.tsx`'s own archive-filter `ToggleGroup` pattern rather than a
// new one-off segmented control (ADR 0003 "Reusable UI components only").
import { SELECTED_SEGMENT_CLASS, ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
// Imported from the leaf `providerLabels.ts`, never `@/lib/modelRoles` (that file imports this
// section's own `CHAT_ROLE_DESCRIPTORS` at its own module top level -- importing it back from
// here, a module `ModelRolesSection.tsx` itself imports, would be a real circular import).
import { friendlyProviderLabel } from '@/lib/providerLabels'

export interface ProviderSwitchProps {
  providers: string[]
  selected: string | null
  onSelect(provider: string): void
}

/** Decision 2 (no "All" option): always exactly one provider selected, never an "All" segment --
 * `providers` already comes pre-populated from the loaded chat catalog, so an empty list (catalog
 * not loaded yet, or genuinely empty) renders nothing rather than an empty, useless switch.
 * Gate round 1 fix (#1114, Flow/Visual Medium #4/#7): a single-provider catalog renders nothing
 * either -- the switch has nothing left to filter once there is only one provider to pick from. */
export function ProviderSwitch({ providers, selected, onSelect }: ProviderSwitchProps) {
  if (providers.length <= 1) return null
  const labelId = 'model-role-provider-switch-label'
  return (
    <div className="mb-3">
      {/* Gate round 1 fix (#1114, Flow/Visual Medium #7): the switch read as an ordinary setting,
          not a filter -- a visible label fixes both the sighted-user ambiguity and the missing
          accessible name (`aria-label="Provider"` alone gave no visible cue at all). */}
      <span id={labelId} className="mb-1 block text-xs text-muted-foreground">
        Show models from
      </span>
      <ToggleGroup
        type="single"
        value={selected ?? undefined}
        onValueChange={(value) => {
          // Radix emits '' when the already-selected segment is clicked again (deselecting it);
          // this switch always keeps exactly one provider selected.
          if (value) onSelect(value)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        aria-labelledby={labelId}
        className="flex-wrap"
      >
        {providers.map((provider) => (
          <ToggleGroupItem key={provider} value={provider} className={SELECTED_SEGMENT_CLASS}>
            {friendlyProviderLabel(provider)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
