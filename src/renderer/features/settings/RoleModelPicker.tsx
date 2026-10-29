// The "Change" dropdown of one model role (extracted from `ModelRolesSection.tsx`, spec 035 T7).
// The current model is shown as text by `RoleCurrentModel`; this control only picks a new one.
// Reasoning-suffix handling is unchanged: picking a fresh catalog selector carries over the role's
// existing `:level` suffix, or writes the bare selector and says so when the new model cannot
// honour that level.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
// `@/lib/providerLabels`, never `@/lib/modelRoles` -- see `ProviderSwitch.tsx`'s import comment.
import { friendlyProviderLabel } from '@/lib/providerLabels'
import type { ModelCatalogEntry } from '../../../shared/model'
import { applyThinkingSuffixCarryOver, splitThinkingSuffix } from './modelRoleSuffix'
import { resolveCatalogEntry } from './modelProviderFilter'
import { isLevelCarryable } from './RoleReasoningRadios'

// `Select` needs a non-empty item value; this sentinel stands for "unset" and is translated back
// to `null` before the write.
const INHERITED_VALUE = '__inherited__'

interface RoleModelPickerProps {
  label: string
  selectId: string
  describedBy?: string
  currentValue: string | undefined
  catalog: ModelCatalogEntry[] | undefined
  /** Chat roles list only the selected provider's models; kind roles keep the whole catalog. */
  displayCatalog: ModelCatalogEntry[]
  isChat: boolean
  selectedProvider: string | null
  isPending: boolean
  hasError: boolean
  unsetLabel: string
  onCommit(value: string | null, announcement?: string): void
  onBusy(): void
  /** Fires when the dropdown opens or closes (the row reveals its thinking radios on first open). */
  onOpenChange?(open: boolean): void
}

export function RoleModelPicker({
  label,
  selectId,
  describedBy,
  currentValue,
  catalog,
  displayCatalog,
  isChat,
  selectedProvider,
  isPending,
  hasError,
  unsetLabel,
  onCommit,
  onBusy,
  onOpenChange
}: RoleModelPickerProps) {
  // A comma list, an `@alias`, a suffixed value or a model of another provider is not listed
  // verbatim: it is pinned as its own item so the picker never shows the wrong thing selected.
  const knownSelectors = new Set(displayCatalog.map((entry) => entry.selector))
  const currentBase = currentValue !== undefined ? splitThinkingSuffix(currentValue).base : undefined
  const hasUnknownCurrent = currentBase !== undefined && !knownSelectors.has(currentBase)
  // Resolved against the FULL catalog so a model of another provider is still identified.
  const resolvedCurrentEntry = isChat ? resolveCatalogEntry(currentValue, catalog) : undefined
  const selectValue = hasUnknownCurrent ? (currentValue ?? INHERITED_VALUE) : (currentBase ?? INHERITED_VALUE)

  function handleValueChange(pickedValue: string): void {
    // The trigger stays focusable while a save is pending (so Radix can return focus to it), so a
    // pick made meanwhile is ignored here and announced instead of silently dropped.
    if (isPending) {
      onBusy()
      return
    }
    if (pickedValue === selectValue) return
    if (pickedValue === INHERITED_VALUE) {
      onCommit(null)
      return
    }
    const carried = applyThinkingSuffixCarryOver(pickedValue, currentValue)
    const carriedSuffix = splitThinkingSuffix(carried).suffix
    if (carriedSuffix && !isLevelCarryable(carriedSuffix.slice(1), resolveCatalogEntry(pickedValue, catalog))) {
      onCommit(pickedValue, `${label} saved; reasoning reset to Inherit`)
      return
    }
    onCommit(carried)
  }

  return (
    <Select value={selectValue} onValueChange={handleValueChange} onOpenChange={onOpenChange}>
      <SelectTrigger
        id={selectId}
        aria-label={`Change ${label} model`}
        aria-describedby={describedBy || undefined}
        aria-disabled={isPending || undefined}
        aria-invalid={hasError || undefined}
        className="w-28"
      >
        <SelectValue>Change</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERITED_VALUE}>{unsetLabel}</SelectItem>
        {hasUnknownCurrent && (
          <SelectItem value={currentValue as string}>
            {resolvedCurrentEntry ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{resolvedCurrentEntry.name}</span>
                {resolvedCurrentEntry.provider !== selectedProvider && (
                  <span className="shrink-0 text-xs text-muted-foreground"> via {friendlyProviderLabel(resolvedCurrentEntry.provider)}</span>
                )}
              </span>
            ) : (
              currentValue
            )}
          </SelectItem>
        )}
        {displayCatalog.map((entry) => (
          <SelectItem key={entry.selector} value={entry.selector}>
            {isChat ? entry.name : `${entry.name} (${entry.provider})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
