// Holds `profileCache.json`: the revalidated GitHub display cache (data-model.md
// "profileCache.json"). Never holds a GitHub access token (FR-012) -- only the two display
// fields derived from a one-time profile/avatar fetch.
//
// `ProfileCache`/`ProfileCacheEntry` are the canonical shapes from `shared/model.ts` (T007);
// re-exported here so every existing import of this file keeps working unchanged.

import path from 'node:path'
import { readJsonFile, writeJsonFile } from './atomicJson'
import type { ProfileCache, ProfileCacheEntry } from '../../shared/model'

export type { ProfileCache, ProfileCacheEntry }

export class ProfileCacheStore {
  private constructor(
    private readonly file: string,
    private data: ProfileCache
  ) { }

  static async open(dir: string): Promise<ProfileCacheStore> {
    const file = path.join(dir, 'profileCache.json')
    const data = await readJsonFile<ProfileCache>(file, () => ({ version: 1, accounts: {} }))
    return new ProfileCacheStore(file, data)
  }

  /** Returns the cached entry for `host/login`, or `null` if never successfully fetched. */
  get(host: string, login: string): ProfileCacheEntry | null {
    return this.data.accounts[`${host}/${login}`] ?? null
  }

  /** Writes a fresh entry for `host/login` (data-model.md "an entry is written whenever a fetch
   * for that `host/login` succeeds"); a failed or skipped fetch must simply not call this. */
  async set(host: string, login: string, entry: ProfileCacheEntry): Promise<void> {
    const next = { ...this.data, accounts: { ...this.data.accounts, [`${host}/${login}`]: entry } }
    this.data = next
    await writeJsonFile(this.file, next)
  }
}
