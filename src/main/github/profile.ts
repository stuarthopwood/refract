// Per-account GitHub profile/avatar fetch (research.md decisions 3-5, contracts/ipc.md): reads a
// short-lived token for one account via the GitHub CLI, makes one bounded `https` request to
// GitHub's REST API with it, and discards the token immediately -- it lives only in this
// module's local scope for that one request, never logged, never written to disk, never sent
// over IPC to the renderer (FR-012, constitution Principle V). A second bounded request
// validates and inlines that account's avatar as a `data:` URL (FR-007, decision 4) so the
// renderer never loads a remote image, or makes the request, itself.

import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import type { SupportedImageMimeType } from '../../shared/frames'
import { matchesImageSignature } from '../../shared/images'
import { authToken } from './cli'

const API_HOST = 'api.github.com'
// GateSec008 HIGH / GateCode008 CRITICAL: the REST call below is hard-coded to api.github.com,
// so a token for any other host (GitHub Enterprise, say) must never even be read, let alone
// sent there. `fetchProfile` enforces this before `authToken` is ever called.
const SUPPORTED_AUTH_HOST = 'github.com'
const AVATAR_HOST = 'avatars.githubusercontent.com'
const REQUEST_TIMEOUT_MS = 10_000
// A GitHub user profile JSON document is a few hundred bytes; generously bounded so a buggy or
// malicious response can never be buffered in full.
const MAX_PROFILE_RESPONSE_BYTES = 64 * 1024
// research.md decision 4: comfortably above GitHub's own largest served avatar size.
const MAX_AVATAR_BYTES = 256 * 1024
const MAX_AVATAR_REDIRECTS = 5

export interface GitHubProfile {
  displayName: string | null
  login: string
  avatarUrl: string | null
}

export class ProfileFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileFetchError'
  }
}

export class AvatarFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AvatarFetchError'
  }
}

/**
 * Reads `host`/`login`'s GitHub profile (research.md decision 3): `authToken` reads that
 * account's token without switching the real active account, held only in the local `token`
 * variable below for the one request it makes, then goes out of scope -- never retained, never
 * passed anywhere else. Throws `GhError` (from `authToken`) or `ProfileFetchError` on failure;
 * callers fall back to the previously cached entry (data-model.md "a failed or skipped fetch...
 * leaves the previous entry untouched").
 */
export async function fetchProfile(host: string, login: string): Promise<GitHubProfile> {
  // Checked BEFORE authToken is ever called (GateSec008 HIGH / GateCode008 CRITICAL): this
  // request always goes to the fixed api.github.com below, so a non-github.com account's token
  // must never be read at all, let alone sent to the wrong server.
  if (host !== SUPPORTED_AUTH_HOST) {
    throw new ProfileFetchError(`profile fetch is only supported for ${SUPPORTED_AUTH_HOST}, not ${host}`)
  }
  const token = await authToken(host, login)
  const body = await requestProfileBody(token)

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ProfileFetchError(`GitHub profile response for ${login} was not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProfileFetchError(`GitHub profile response for ${login} was not a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const displayName = typeof record['name'] === 'string' ? record['name'] : null
  const avatarUrl = typeof record['avatar_url'] === 'string' ? record['avatar_url'] : null
  const respondedLogin = typeof record['login'] === 'string' ? record['login'] : login
  return { displayName, login: respondedLogin, avatarUrl }
}

function requestProfileBody(token: string): Promise<string> {
  // Executor form: Promise.withResolvers() needs lib "ES2024"; tsconfig.node.json is pinned to
  // "ES2023" (see git.ts's `gitRaw`/OmpProcess's `start()` for the same documented exception).
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path: '/user',
        method: 'GET',
        headers: {
          // Held only in this one request's headers object; never logged, never written to disk.
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Refract'
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        collectBounded(res, MAX_PROFILE_RESPONSE_BYTES)
          .then((respBody) => {
            if (res.statusCode !== 200) {
              reject(new ProfileFetchError(`GitHub profile request failed with status ${res.statusCode ?? 'unknown'}`))
              return
            }
            resolve(respBody.toString('utf8'))
          })
          .catch(reject)
      }
    )
    req.on('timeout', () => req.destroy(new ProfileFetchError('GitHub profile request timed out')))
    req.on('error', (err) => reject(err instanceof Error ? err : new ProfileFetchError(String(err))))
    req.end()
  })
}

/** Reads a response body up to `maxBytes`; destroys the response and rejects once exceeded, so a
 * huge or malicious response can never be buffered in full. */
function collectBounded(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  // Executor form: see requestProfileBody above for why Promise.withResolvers() isn't available.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    res.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        res.destroy()
        reject(new Error(`response exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

interface AvatarResponse {
  statusCode: number
  contentType: string | undefined
  location: string | undefined
  body: Buffer
}

/**
 * Fetches `avatarUrl` and returns it as a validated `data:image/png;base64,...` or
 * `data:image/jpeg;base64,...` string (FR-007, research.md decision 4). Every URL this function
 * actually requests -- the one passed in, and the target of any redirect -- is bounded to host
 * `avatars.githubusercontent.com` before it is requested, so a redirect can never be trusted into
 * fetching some other host (SSRF-via-redirect); the response must also declare `Content-Type:
 * image/png` or `image/jpeg` AND its first bytes must match that format's real magic number, and
 * the body is capped at 256 KiB. Throws `AvatarFetchError` on any rejection; callers fall back to
 * initials (FR-007).
 */
export async function fetchAvatar(avatarUrl: string): Promise<string> {
  let current = parseAvatarUrl(avatarUrl)
  let response = await requestAvatarOnce(current)

  let redirects = 0
  while (response.statusCode >= 300 && response.statusCode < 400 && response.location) {
    if (redirects >= MAX_AVATAR_REDIRECTS) {
      throw new AvatarFetchError('avatar request redirected too many times')
    }
    redirects += 1
    current = parseAvatarUrl(new URL(response.location, current).toString())
    response = await requestAvatarOnce(current)
  }

  if (response.statusCode !== 200) {
    throw new AvatarFetchError(`avatar request failed with status ${response.statusCode}`)
  }

  const mimeType = resolveAvatarMimeType(response.contentType)
  if (!mimeType) {
    throw new AvatarFetchError('avatar response had an unsupported Content-Type')
  }
  if (!matchesImageSignature(response.body, mimeType)) {
    throw new AvatarFetchError(`avatar response bytes did not match its declared ${mimeType} signature`)
  }
  return `data:${mimeType};base64,${response.body.toString('base64')}`
}

/** Parses `value` and asserts it is an `https:` URL on `avatars.githubusercontent.com` --
 * applied to the initial URL and to every redirect target before it is ever requested. */
function parseAvatarUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AvatarFetchError(`avatar URL "${value}" is not a valid URL`)
  }
  if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST) {
    throw new AvatarFetchError(`avatar host "${url.hostname}" is not ${AVATAR_HOST}`)
  }
  return url
}

function resolveAvatarMimeType(contentType: string | undefined): SupportedImageMimeType | null {
  if (!contentType) return null
  const base = contentType.split(';')[0]?.trim().toLowerCase()
  if (base === 'image/png') return 'image/png'
  if (base === 'image/jpeg') return 'image/jpeg'
  return null
}

function requestAvatarOnce(url: URL): Promise<AvatarResponse> {
  // Executor form: see requestProfileBody above for why Promise.withResolvers() isn't available.
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'Refract' },
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        collectBounded(res, MAX_AVATAR_BYTES)
          .then((body) =>
            resolve({
              statusCode: res.statusCode ?? 0,
              contentType: res.headers['content-type'],
              location: res.headers.location,
              body
            })
          )
          .catch(reject)
      }
    )
    req.on('timeout', () => req.destroy(new AvatarFetchError('avatar request timed out')))
    req.on('error', (err) => reject(err instanceof Error ? err : new AvatarFetchError(String(err))))
    req.end()
  })
}
