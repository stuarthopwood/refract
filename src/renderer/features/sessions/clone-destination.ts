// Pure helpers for the Clone dialog's destination field (spec 054 FR-033..FR-036). Paths are
// handled as plain strings: the renderer never touches the file system, Rust validates.

/** The repository name in a clone source (`owner/name`, or a github.com URL), or `null`. */
export function repoNameFromSource(source: string): string | null {
  const trimmed = source.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const match = /^(?:https:\/\/github\.com\/)?[A-Za-z0-9][A-Za-z0-9-]*\/([A-Za-z0-9._-]+)$/.exec(trimmed)
  return match ? match[1] : null
}

/** Light shape check only (`owner/name` or a github.com URL); Rust does the authoritative one. */
export function isPlausibleSource(source: string): boolean {
  return repoNameFromSource(source) !== null
}

function separatorFor(path: string): string {
  return path.includes('/') && !path.includes('\\') ? '/' : '\\'
}

/** `<folder>\<name>`, keeping the folder's own separator style. */
export function joinPath(folder: string, name: string): string {
  const separator = separatorFor(folder)
  return `${folder.replace(/[\\/]+$/, '')}${separator}${name}`
}

/** The parent folder of `path`, or `null` when it has none. */
export function parentOf(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index <= 0) return null
  const parent = trimmed.slice(0, index)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return normalise(a) === normalise(b)
}

/** Whether the "Use this folder for future clones" checkbox shows, and its initial state:
 *  ticked with no default, unticked-but-shown when the parent differs, hidden when equal. */
export function defaultFolderCheckbox(
  destination: string,
  defaultFolder: string | null | undefined
): { visible: boolean; initiallyChecked: boolean } {
  const parent = parentOf(destination)
  if (!parent) return { visible: false, initiallyChecked: false }
  if (!defaultFolder) return { visible: true, initiallyChecked: true }
  return samePath(parent, defaultFolder) ? { visible: false, initiallyChecked: false } : { visible: true, initiallyChecked: false }
}
