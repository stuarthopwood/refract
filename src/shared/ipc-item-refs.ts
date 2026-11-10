// The `itemRefs.*` IPC contract (#1155): the data behind the hover Item card for `#123` / `owner/repo#123`.

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

export interface ItemRefsApi {
  /** One item's card. `owner`/`repo` both null means the Project's own GitHub repository. Called only on hover or click. */
  lookup(repositoryId: string, owner: string | null, repo: string | null, number: number): Promise<Result<ItemCard>>;
}
