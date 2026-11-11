// The `itemRefs.*` IPC contract: the data behind the hover Item card for `#123` / `owner/repo#123` (#1155)
// and the rows of the composer `#` picker (#1789).

import type { Result } from './ipc';

/** Every text field comes from GitHub and is untrusted: render it as text, never as markup. */
export interface ItemCard {
  /** `owner/repo` the item lives in. */
  ownerRepo: string;
  number: number;
  kind: 'issue' | 'pull-request';
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  url: string;
  createdAt: string;
  authorLogin: string;
  /** A `data:` URL (the CSP allows no remote images); null when the avatar could not be fetched. */
  avatarDataUrl: string | null;
  /** Pull requests only. */
  baseRef: string | null;
  headRef: string | null;
}

/** One row of the `#` picker. The title comes from GitHub and is untrusted: render it as text. */
export interface ItemSummary {
  number: number;
  kind: 'issue' | 'pull-request';
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}

export interface ItemRefsApi {
  /** One item's card. `owner`/`repo` both null means the Project's own GitHub repository. Called only on hover or click. */
  lookup(repositoryId: string, owner: string | null, repo: string | null, number: number): Promise<Result<ItemCard>>;
  /**
   * At most 10 issues and pull requests of the Project's own GitHub repository. An empty query lists
   * recent open items; a digits-only query also pins that exact number first.
   */
  search(repositoryId: string, query: string): Promise<Result<ItemSummary[]>>;
}
