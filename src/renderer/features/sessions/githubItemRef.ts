import type { Repository } from '../../../shared/model'
import type { ItemRef } from './startSessionFromItem'

const GITHUB_ITEM_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d{1,10})\/?(?:[?#].*)?$/

export type ParsedItem =
  | { ok: true; ref: ItemRef }
  | { ok: false; message: string }

/** Parses a pasted issue/pull request URL (owner/repo must match the Project's remote) or, with `presetKind`, a bare `123` / `#123`. */
export function parseItemRef(text: string, repository: Repository, presetKind?: ItemRef['kind']): ParsedItem {
  const value = text.trim()
  const url = GITHUB_ITEM_URL.exec(value)
  if (url) {
    const remote = repository.remote
    const matches =
      remote?.kind === 'has' &&
      remote.owner?.toLowerCase() === url[1]!.toLowerCase() &&
      remote.repo?.toLowerCase() === url[2]!.toLowerCase()
    if (!matches) return { ok: false, message: `That link is for ${url[1]}/${url[2]}, not this project.` }
    return { ok: true, ref: { kind: url[3] === 'issues' ? 'issue' : 'pull-request', repositoryId: repository.id, number: Number(url[4]) } }
  }
  const bare = /^#?(\d{1,10})$/.exec(value)
  if (bare && presetKind) {
    return { ok: true, ref: { kind: presetKind, repositoryId: repository.id, number: Number(bare[1]) } }
  }
  return { ok: false, message: presetKind ? 'Enter a number or a GitHub link.' : 'Paste a GitHub issue or pull request link.' }
}
