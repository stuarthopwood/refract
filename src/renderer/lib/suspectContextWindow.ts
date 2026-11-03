import type { ModelCatalogEntry } from '../../shared/model'
import { compactNumber } from './compactNumber'

export const SUSPECT_WINDOW_ISSUE_URL = 'https://github.com/can1357/oh-my-pi/issues/17481'
export const SUSPECT_WINDOW_LINK_LABEL = 'Why this window may be wrong (oh-my-pi#17481)'
export const SUSPECT_WINDOWS_LINK_LABEL = 'Why these windows may be wrong (oh-my-pi#17481)'
const LONG_SUFFIX = '-1m'

export interface SuspectWindow {
  provider: string
  id: string
  name: string
  siblingId: string
  siblingName: string
  windowTokens: number
}

/** Base models whose reported window equals their `-1m` sibling's on the same provider; OMP's numbers are never replaced. */
export function suspectContextWindows(catalog: readonly ModelCatalogEntry[] | undefined): SuspectWindow[] {
  if (!catalog) return []
  const byKey = new Map(catalog.map((entry) => [`${entry.provider}/${entry.id}`, entry]))
  const suspects: SuspectWindow[] = []
  for (const entry of catalog) {
    if (entry.id.endsWith(LONG_SUFFIX) || typeof entry.contextWindow !== 'number') continue
    const sibling = byKey.get(`${entry.provider}/${entry.id}${LONG_SUFFIX}`)
    if (sibling?.contextWindow !== entry.contextWindow) continue
    suspects.push({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
      siblingId: sibling.id,
      siblingName: sibling.name,
      windowTokens: entry.contextWindow
    })
  }
  return suspects
}

export function findSuspectWindow(
  catalog: readonly ModelCatalogEntry[] | undefined,
  model: { provider: string; id: string } | null | undefined
): SuspectWindow | null {
  if (!model) return null
  return suspectContextWindows(catalog).find((s) => s.provider === model.provider && s.id === model.id) ?? null
}

/** The shared note for the readout tooltip and the Settings list. */
export function suspectWindowNote(s: SuspectWindow): string {
  const size = compactNumber(s.windowTokens)
  return `The agent reports the same ${size} window for ${s.name} (${s.id}) and ${s.siblingName} (${s.siblingId}). The percentage and auto-compaction may be wrong. Use the ${LONG_SUFFIX} model variant, or set a window in modelOverrides.`
}
