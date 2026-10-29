// One labelled Settings row (ADR 0003, reusable components): an optional leading icon in a fixed
// 16px slot, a label, a muted description (and an optional note such as a validation message), and
// the control passed as children. The control points `aria-describedby` at `${id}-description`
// (and at the note's id when it renders one). Below ~480px (container query) the control stacks
// under the label. Replaces the hand-copied row markup; `SettingFieldRow` and `SettingSwitchRow`
// delegate here.
import type { ComponentType, ReactNode } from 'react'
import { useSettingsGroupIconSlot } from './SettingsGroup'

export type SettingIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

interface SettingRowProps {
  id: string
  label: string
  description?: ReactNode
  note?: ReactNode
  icon?: SettingIcon
  /** The id the label points at; defaults to `id`. */
  controlId?: string
  /** Render the label as a plain `span` (for a control group that is labelled through `aria-labelledby`). */
  labelAsText?: boolean
  /** Rendered inline after the label (for example a decorative colour swatch). */
  labelAddon?: ReactNode
  /** `stacked` puts the control below the label at every width (for wide controls such as lists and tables). */
  layout?: 'inline' | 'stacked'
  children?: ReactNode
}

export function SettingRow({ id, label, description, note, icon: Icon, controlId, labelAsText = false, labelAddon, layout = 'inline', children }: SettingRowProps) {
  const groupHasIconSlot = useSettingsGroupIconSlot()
  const layoutClass =
    layout === 'stacked'
      ? 'flex-col items-stretch'
      : 'flex-wrap items-center justify-between @max-md:flex-col @max-md:items-start'
  return (
    <div className="@container">
      <div className={`flex gap-x-4 gap-y-2 py-4 ${layoutClass}`}>
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {(Icon || groupHasIconSlot) && (
            <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {Icon && <Icon aria-hidden className="size-4" />}
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              {labelAsText ? (
                <span id={`${id}-label`} className="text-sm">
                  {label}
                </span>
              ) : (
                <label id={`${id}-label`} htmlFor={controlId ?? id} className="text-sm">
                  {label}
                </label>
              )}
              {labelAddon}
            </div>
            {description && (
              <span id={`${id}-description`} className="text-xs text-muted-foreground">
                {description}
              </span>
            )}
            {note}
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
