// One labelled Settings row (ADR 0003, reusable components): a label, a muted description (and an
// optional note such as a validation message) on the left, and the control passed as children on
// the right. The control is expected to point `aria-describedby` at `${id}-description` (and at
// the note's id when it renders one). Wraps on narrow panes. Shared by `SettingSwitchRow` and the
// Settings > OMP value rows instead of each repeating the same markup.
import type { ReactNode } from 'react'

interface SettingFieldRowProps {
  id: string
  label: string
  description: ReactNode
  note?: ReactNode
  children: ReactNode
}

export function SettingFieldRow({ id, label, description, note, children }: SettingFieldRowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </span>
        {note}
      </div>
      {children}
    </div>
  )
}
