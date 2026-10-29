// #1284: the one-line plain-language hint for a Turn error row, chosen from OMP's own error text.
// Pure, so the transcript row and any other reader share it. Unknown kinds get no hint.
export type TurnErrorKind = 'tls' | 'auth' | 'rate-limit'

export const TURN_ERROR_HINTS: Record<TurnErrorKind, string> = {
  tls: 'Your network or security software is inspecting TLS. Restart the agent to load the current certificates.',
  auth: 'The provider rejected your sign-in or API key. Sign in again or check the credentials.',
  'rate-limit': 'The provider is rate limiting requests. Wait a moment, then retry.'
}

const TLS_PATTERN = /\bTLS\b|\bSSL\b|certificate|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_[A-Z_]+/i
const AUTH_PATTERN = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|invalid[ _-]?(?:api[ _-]?)?key|credential|not logged in|token (?:has )?expired/i
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests|quota|overloaded/i

export function classifyTurnError(text: string): TurnErrorKind | null {
  if (TLS_PATTERN.test(text)) return 'tls'
  if (AUTH_PATTERN.test(text)) return 'auth'
  if (RATE_LIMIT_PATTERN.test(text)) return 'rate-limit'
  return null
}
