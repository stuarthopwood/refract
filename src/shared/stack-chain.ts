// Chains pull requests into stacks by base/head branch (#1867). Used when the checkout cannot answer `gh stack view`.

export interface ChainablePullRequest {
  number: number
  headRef: string
  baseRef: string
  state: 'open' | 'merged' | 'closed'
}

export interface StackPosition {
  /** 1-based, bottom layer first. */
  position: number
  total: number
  layers: number[]
}

/** Returns the chain a pull request sits in, or `null` when it has no neighbour. */
export function chainFor(all: readonly ChainablePullRequest[], number: number): StackPosition | null {
  const byHead = new Map<string, ChainablePullRequest>()
  const byBase = new Map<string, ChainablePullRequest[]>()
  for (const pr of all) {
    byHead.set(pr.headRef, pr)
    byBase.set(pr.baseRef, [...(byBase.get(pr.baseRef) ?? []), pr])
  }
  const start = all.find((pr) => pr.number === number)
  if (!start) return null

  const seen = new Set<number>([start.number])
  const down: ChainablePullRequest[] = []
  for (let cur = byHead.get(start.baseRef); cur && !seen.has(cur.number); cur = byHead.get(cur.baseRef)) {
    seen.add(cur.number)
    down.unshift(cur)
  }
  const up: ChainablePullRequest[] = []
  for (let cur = start; ; ) {
    // A forked base (two children) is ambiguous, so the chain stops rather than guess.
    const children = (byBase.get(cur.headRef) ?? []).filter((pr) => !seen.has(pr.number))
    if (children.length !== 1) break
    seen.add(children[0].number)
    up.push(children[0])
    cur = children[0]
  }
  const layers = [...down, start, ...up]
  if (layers.length < 2) return null
  return { position: down.length + 1, total: layers.length, layers: layers.map((pr) => pr.number) }
}
