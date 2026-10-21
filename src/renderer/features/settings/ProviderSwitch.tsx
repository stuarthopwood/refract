// Issue #1069 decision 1: one provider segmented control (ADR 0003) above the chat-role list,
// extending `ManageSessionsToolbar.tsx`'s own archive-filter `ToggleGroup` pattern rather than a
// new one-off segmented control (ADR 0003 "Reusable UI components only").
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
// Imported from the leaf `providerLabels.ts`, never `@/lib/modelRoles` (that file imports this
// section's own `CHAT_ROLE_DESCRIPTORS` at its own module top level -- importing it back from
// here, a module `ModelRolesSection.tsx` itself imports, would be a real circular import).
import { friendlyProviderLabel } from '@/lib/providerLabels'

// Same treatment as `ManageSessionsToolbar.tsx`'s own `SELECTED_SEGMENT_CLASS` (DESIGN.md's
// "Active/selected indicator" rule: a 2px left-edge bar, overriding `toggle.tsx`'s own default
// `data-[state=on]:bg-primary` fill). Kept as this file's own copy, matching the established
// per-file class-constant convention for a cross-file shared look (e.g. `RADIO_RING_CLASS`),
// rather than importing a toolbar-scoped constant from a sibling feature folder.
const SELECTED_SEGMENT_CLASS =
  'data-[state=on]:bg-muted data-[state=on]:text-foreground data-[state=on]:hover:bg-muted data-[state=on]:shadow-[inset_2px_0_0_0_var(--color-active-indicator)]'

export interface ProviderSwitchProps {
  providers: string[]
  selected: string | null
  onSelect(provider: string): void
}

/** Decision 2 (no "All" option): always exactly one provider selected, never an "All" segment --
 * `providers` already comes pre-populated from the loaded chat catalog, so an empty list (catalog
 * not loaded yet, or genuinely empty) renders nothing rather than an empty, useless switch. */
export function ProviderSwitch({ providers, selected, onSelect }: ProviderSwitchProps) {
  if (providers.length === 0) return null
  return (
    <ToggleGroup
      type="single"
      value={selected ?? undefined}
      onValueChange={(value) => {
        // Radix emits '' when the already-selected segment is clicked again (deselecting it);
        // this switch always keeps exactly one provider selected.
        if (value) onSelect(value)
      }}
      variant="outline"
      spacing={0}
      aria-label="Provider"
      className="mb-3"
    >
      {providers.map((provider) => (
        <ToggleGroupItem key={provider} value={provider} className={SELECTED_SEGMENT_CLASS}>
          {friendlyProviderLabel(provider)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
