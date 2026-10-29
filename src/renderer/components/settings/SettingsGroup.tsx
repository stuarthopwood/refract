// A titled Settings group (CONTEXT.md "Settings group"): an `h3` heading, an optional hint, and a
// stack of `SettingRow`s divided by `--divider`. `role="group"` is labelled by the heading.
// `iconSlot` reserves the leading 16px icon column in every row, so labels stay aligned when only
// some rows have a distinct glyph.
import { createContext, useContext, useId } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const IconSlotContext = createContext(false)

export function useSettingsGroupIconSlot(): boolean {
  return useContext(IconSlotContext)
}

interface SettingsGroupProps {
  title: string
  description?: ReactNode
  /** Override the generated heading id (callers that query or reference the heading by id). */
  headingId?: string
  descriptionId?: string
  iconSlot?: boolean
  className?: string
  children: ReactNode
}

export function SettingsGroup({ title, description, headingId, descriptionId, iconSlot = false, className, children }: SettingsGroupProps) {
  const generatedId = useId()
  const headingElementId = headingId ?? `${generatedId}-heading`
  const descriptionElementId = descriptionId ?? `${generatedId}-description`
  return (
    <div role="group" aria-labelledby={headingElementId} className={cn('mb-6 flex flex-col last:mb-0', className)}>
      <h3 id={headingElementId} className="text-sm font-medium">
        {title}
      </h3>
      {description && (
        <p id={descriptionElementId} className="mt-1 text-xs text-muted-foreground">
          {description}
        </p>
      )}
      <IconSlotContext.Provider value={iconSlot}>
        <div className="flex flex-col divide-y divide-divider">{children}</div>
      </IconSlotContext.Provider>
    </div>
  )
}
