/** `github:changed`: a PR or issue was merged, closed, created or edited (in the app or by a Session agent). */
export interface GithubChangedPayload {
  /** Absent when the repository is not a registered Project. */
  repositoryId?: string | null;
  kind: 'pr' | 'issue';
  number: number;
}
