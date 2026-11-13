// Finds `#123` / `owner/repo#123` in Markdown prose (#1155) and resolves one to a lookup target.
// Parsing a reference to a Project item reuses `parseItemRef` (the New Session dialog's parser).
import type { Repository } from '../../../shared/model'
import { parseItemRef } from '../sessions/githubItemRef'

// The lookbehind rejects `abc#1`, `a.b/c#1`, `&#123;` and `##1`; the lookahead rejects `#1abc`.
const ITEM_REF = /(?<![\w/.&#-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}))?#(\d{1,10})(?!\w)/g

export const ITEM_REF_TAG = 'item-ref'

export interface ItemRefTarget {
  /** The Project the chat belongs to; the backend uses its checkout for `gh`. */
  repositoryId: string
  /** Both null means the Project's own GitHub repository. */
  owner: string | null
  repo: string | null
  number: number
  /** False when `owner/repo` names a repository that is not this Project's. */
  inProject: boolean
}

/** Splits `text` into plain strings and matched references, or null when it has none. */
export function splitItemRefs(text: string): Array<{ text: string; ref: boolean }> | null {
  const parts: Array<{ text: string; ref: boolean }> = []
  let last = 0
  for (const match of text.matchAll(ITEM_REF)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at), ref: false })
    parts.push({ text: match[0], ref: true })
    last = at + match[0].length
  }
  if (parts.length === 0) return null
  if (last < text.length) parts.push({ text: text.slice(last), ref: false })
  return parts
}

/** `owner/repo` a reference lives in: its own qualifier, else the Project's GitHub remote; null when neither exists. */
export function ownerRepoOf(target: Pick<ItemRefTarget, 'owner' | 'repo'>, repository: Repository | undefined): string | null {
  if (target.owner) return `${target.owner}/${target.repo}`
  const remote = repository?.remote
  return remote?.kind === 'has' ? `${remote.owner}/${remote.repo}` : null
}

/** Null for a bare `#123` when the Project has no GitHub repository: that stays plain text. */
export function resolveItemRef(text: string, repository: Repository): ItemRefTarget | null {
  const qualified = /^([^/#]+)\/([^#]+)#(\d+)$/.exec(text)
  if (!qualified) {
    const parsed = parseItemRef(text, repository, 'issue')
    return repository.remote?.kind === 'has' && parsed.ok
      ? { repositoryId: repository.id, owner: null, repo: null, number: parsed.ref.number, inProject: true }
      : null
  }
  const [, owner, repo, number] = qualified
  const parsed = parseItemRef(`https://github.com/${owner}/${repo}/issues/${number}`, repository)
  const base = { repositoryId: repository.id, number: Number(number) }
  return parsed.ok
    ? { ...base, owner: null, repo: null, inProject: true }
    : { ...base, owner: owner!, repo: repo!, inProject: false }
}

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIPPED_TAGS = new Set(['code', 'pre', 'a', ITEM_REF_TAG])

function linkChildren(parent: HastNode): void {
  if (!parent.children || (parent.tagName && SKIPPED_TAGS.has(parent.tagName))) return
  const next: HastNode[] = []
  for (const child of parent.children) {
    const parts = child.type === 'text' && child.value?.includes('#') ? splitItemRefs(child.value) : null
    if (!parts) {
      linkChildren(child)
      next.push(child)
      continue
    }
    for (const part of parts) {
      next.push(
        part.ref
          ? { type: 'element', tagName: ITEM_REF_TAG, properties: {}, children: [{ type: 'text', value: part.text }] }
          : { type: 'text', value: part.text }
      )
    }
  }
  parent.children = next
}

/** Runs after `rehype-sanitize`, so the custom tag it adds is never stripped. */
export function rehypeItemRefs() {
  return (tree: HastNode): void => linkChildren(tree)
}
