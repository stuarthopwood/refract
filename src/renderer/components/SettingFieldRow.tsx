// Thin wrapper kept for existing callers (Settings > OMP value rows): the shared `SettingRow` owns
// the layout. `wrap` is now always on (the row stacks under ~480px).
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings/SettingRow'

interface SettingFieldRowProps {
  id: string
  label: string
  description: ReactNode
  note?: ReactNode
  wrap?: boolean
  children: ReactNode
}

export function SettingFieldRow({ id, label, description, note, children }: SettingFieldRowProps) {
  return (
    <SettingRow id={id} label={label} description={description} note={note}>
      {children}
    </SettingRow>
  )
}
