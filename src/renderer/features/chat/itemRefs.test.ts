// Issue #1950: the `owner/repo` a chat reference lives in, which becomes the GitHub URL of a browser open.
import { describe, expect, it } from 'vitest'
import type { Repository } from '../../../shared/model'
import { ownerRepoOf } from './itemRefs'

const withRemote = { id: 'repo-1', remote: { kind: 'has', owner: 'me', repo: 'app' } } as unknown as Repository
const noRemote = { id: 'repo-1', remote: { kind: 'none' } } as unknown as Repository

describe('ownerRepoOf', () => {
  it('uses the reference own owner/repo before the Project remote', () => {
    expect(ownerRepoOf({ owner: 'other', repo: 'lib' }, withRemote)).toBe('other/lib')
  })

  it('falls back to the Project GitHub remote for a bare reference', () => {
    expect(ownerRepoOf({ owner: null, repo: null }, withRemote)).toBe('me/app')
  })

  it('is null when a bare reference has no GitHub remote or no Project', () => {
    expect(ownerRepoOf({ owner: null, repo: null }, noRemote)).toBeNull()
    expect(ownerRepoOf({ owner: null, repo: null }, undefined)).toBeNull()
  })
})
