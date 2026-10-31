import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { buildStarterJson } from '@/lib/themeTokens'
import { notify } from '@/state/notify'
import { useThemeStore } from '@/state'
import type { CustomTheme } from '../../../shared/ipc-themes'
import type { ThemeId } from '../../../shared/themes'

/** Import, export, remove and folder actions for custom theme files; each failure surfaces as a toast. */
export function useThemeFileActions() {
  const refresh = useThemeStore((s) => s.refreshCustomThemes)
  const [pendingRemove, setPendingRemoveRaw] = useState<CustomTheme | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const setPendingRemove = (t: CustomTheme | null) => {
    setRemoveError(null)
    setPendingRemoveRaw(t)
  }
  const removed = useRef(false)

  async function importTheme() {
    if (importing) return
    setImportError(null)
    setImporting(true)
    try {
      const result = await window.refract.themes.import()
      if (!result.ok) {
        setImportError(result.error.message)
        return
      }
      await refresh()
      if (result.value) toast.success(`Imported ${result.value.name}.`)
    } finally {
      setImporting(false)
    }
  }

  async function exportJson(name: string, json: string) {
    const result = await window.refract.themes.export(name, json)
    if (!result.ok) notify(result.error)
    else if (result.value) toast.success('Theme exported.')
  }

  const exportCustom = (t: CustomTheme) =>
    exportJson(t.name, JSON.stringify({ version: 1, name: t.name, base: t.base, tokens: t.tokens }, null, 2))
  const exportBuiltin = (id: ThemeId, name: string) => exportJson(`${name} copy`, buildStarterJson(`${name} copy`, id))

  async function showInFolder(id?: string) {
    const result = await window.refract.themes.openFolder(id)
    if (!result.ok) notify(result.error)
  }

  async function confirmRemove() {
    if (!pendingRemove) return
    setBusy(true)
    setRemoveError(null)
    let succeeded = false
    try {
      const result = await window.refract.themes.remove(pendingRemove.id)
      if (!result.ok) {
        setRemoveError(result.error.message)
        return
      }
      succeeded = true
      removed.current = true
      await refresh()
    } finally {
      setBusy(false)
      if (succeeded) setPendingRemove(null)
    }
  }

  return { importTheme, importing, importError, exportCustom, exportBuiltin, showInFolder, pendingRemove, setPendingRemove, confirmRemove, removeError, busy, removed }
}
