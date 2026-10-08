// Redacts credential-shaped substrings from diagnostic text before it reaches a transcript
// notice, `stopDetail`, or any other IPC payload (gate-fixes security finding, issue #512): the
// stderr tail and the omp log tail can both carry provider or MCP error lines containing bearer
// tokens or query-string credentials, and neither tail was ever meant to be a secrets channel.
//
// Gate-fixes security Medium finding (cycle 2): the first pass missed several common shapes --
// hyphenated provider keys (sk-ant-/sk-proj-), the newer GitHub token prefixes and fine-grained
// PATs, JSON-quoted `"key":"value"` pairs, underscore-prefixed OAuth token names, password/
// secret fields, and URL userinfo.
//
// Gate-fixes security Medium finding (cycle 3): the JSON-quoted case above only handled a
// top-level `"key":"value"` pair, not one escaped a level deeper (`error=\"{\"api_key\":...}\"`,
// how a provider's own JSON error body looks once embedded in an outer quoted log field) --
// the separator/value groups now tolerate an optional leading backslash and treat `\"` inside a
// value as an escaped character rather than a terminator, so an escaped closing quote no longer
// leaks the rest of the value, and a value with no closing quote at all (exactly what a
// truncated line produces) still gets redacted instead of passing through untouched. Also
// widened: bare JWTs, Cookie/Set-Cookie headers, and non-http(s) URL userinfo (mongodb+srv://,
// postgres://, redis://, wss://, ...).
//
// Gate-fixes security/test Medium findings (cycle 4): cycle 3's `(?<![a-z])` lookbehind, meant
// only to stop the bare `key` alternative firing inside "monkey", was wrongly applied to the
// WHOLE key-name group under the case-insensitive `/i` flag -- it also blocked every camelCase
// form (sessionToken, clientSecret, secretAccessKey, privateKey, apiToken, githubToken,
// accessKey, dbPassword, ...), which cycle 2 redacted correctly. The lookbehind is removed from
// the shared group; `key` now has its own dedicated, explicitly-cased pattern (lowercase `key`
// only outside a word, camelCase `Key` only right after a lowercase/digit boundary, or bare
// `KEY`), which a single `/i`-flagged alternative cannot express (case-insensitive matching
// defeats a lookbehind that needs to tell `k`/`K` apart). The Authorization/Cookie pattern is
// widened the same way the key=value one already was (JSON/JS-object quoting, escaped quotes,
// single quotes) and made properly case-insensitive (`SET-COOKIE:`/`COOKIE:` used to slip
// through a pattern with no `/i` at all). URL userinfo now redacts up to the LAST unescaped `@`
// before the host, so a raw `@` inside the password itself no longer leaks a trailing fragment,
// and the scheme prefix is bounded (`{0,31}`) against the one pattern flagged with non-trivial
// backtracking cost on pathological input.

const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, replace: '$1 [redacted]' },
  // No trailing `\b`: Anthropic/OpenAI keys embed hyphens (sk-ant-api03-…, sk-proj-…), which a
  // word boundary stops matching mid-key.
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}/g, replace: '[redacted]' },
  // `gh[pousr]_` covers personal/oauth/user/server/refresh tokens; `github_pat_` covers
  // fine-grained PATs. Kept at the original 10-char minimum (not a stricter real-world length)
  // so this still matches the shorter tokens the existing tests use.
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, replace: '[redacted]' },
  // Bare JWT: three dot-separated base64url segments, each starting `eyJ` (a base64'd `{"`).
  // Redacted whole: unlike the key=value forms below, there is no key name worth preserving.
  { pattern: /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, replace: '[redacted]' },
  // Gate-fixes security Medium finding (cycle 5): AWS access key IDs, bare Google/Gemini API
  // keys (omp has a Google provider), Slack tokens, GitLab/npm/Hugging Face tokens, and PEM
  // private-key blocks all passed through unredacted.
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[redacted]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: '[redacted]' },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: '[redacted]' },
  { pattern: /\b(?:glpat-|npm_|hf_)[A-Za-z0-9_-]{16,}/g, replace: '[redacted]' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: '[redacted private key]' },
  // Gate-fixes security Low finding (cycle 7): a 64 KiB read window (or the stderr sliding
  // window) can start PARTWAY through a private-key block, after its BEGIN marker already
  // scrolled out -- the pattern above needs BEGIN to fire at all, so the remaining base64 body
  // plus the END marker passed through unredacted. Runs AFTER the BEGIN pattern (so a properly
  // terminated block is never double-matched): any leftover END marker with no BEGIN before it
  // redacts everything up to and including it.
  { pattern: /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[redacted private key]' },
  // One key-name pattern covering api_key/apikey/x-api-key/x-goog-api-key/token (and
  // underscore-prefixed access_token/refresh_token/id_token/auth_token, and their camelCase
  // equivalents: accessToken, sessionToken, apiToken, githubToken, bearerToken, ...)/password/
  // passwd/pwd/secret/client_secret/credential(s)/auth (and camelCase: clientSecret,
  // secretAccessKey, dbPassword, userPassword, ...). No lookbehind here (cycle 2 behaviour,
  // restored) -- `key` alone is handled by its own pattern below, where the "monkey" false-
  // positive actually lives. Gate-fixes security Medium finding (cycle 5): added pwd/
  // credential(s)/auth -- ODBC-style connection strings (`Pwd=`) and Azure blob URLs
  // (`credentials=`) both turn up in MCP/embedding error lines; bare `sig` (the Azure SAS query
  // parameter) is deliberately NOT added here -- it is a substring of ordinary words
  // (`design`, `signature`, `assign`), so it has its own query-string-scoped pattern below
  // instead. The separator and value groups both tolerate an optional leading backslash and an
  // optional leading quote (double OR single, for `'Authorization': 'Basic xyz'`-style JS-object
  // quoting); the value group treats `\"` as an escaped character inside the value rather than
  // a terminator (so an escaped closing quote doesn't leak the rest of the value), excludes
  // newlines (so an unterminated value in a multi-line tail only swallows its own line, not
  // every line after it), and its closing quote is optional (so a value with no terminator at
  // all -- a truncated line -- still redacts instead of passing through untouched).
  // Gate-fixes security Low finding (cycle 6): bare `auth` is preceded by `(?<![A-Za-z])` --
  // without it, under the shared `/i` flag, it matched the "auth" substring inside "OAuth:",
  // redacting an ordinary "OAuth: failed to refresh" diagnostic line's own text.
  {
    pattern:
      /((?:access|refresh|id|auth)?_?[Tt]oken|x-(?:api|goog-api)-key|api[_-]?key|apikey|password|passwd|pwd|secret|client_secret|credentials?|(?<![A-Za-z])auth)(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)/gi,
    replace: '$1$2[redacted]',
  },
  // Azure SAS `sig` query parameter, scoped to the query-string shape (`?sig=`/`&sig=`) rather
  // than a bare key-name alternative: "sig" is a substring of ordinary words (design, signature,
  // assign), which the main key-name pattern above would otherwise false-positive on.
  { pattern: /([?&]sig=)[^&\s]+/gi, replace: '$1[redacted]' },
  // `key` alone, split out from the group above: a single case-insensitive alternative cannot
  // tell "monkey" (lowercase `key` as the tail of an ordinary word -- must NOT redact) apart
  // from "secretKey"/"privateKey" (camelCase `Key` right after a lowercase/digit boundary --
  // MUST redact) or `PRIVATE_KEY` (bare upper-case `KEY` -- MUST redact), because `/i` makes
  // `[a-z]` and `[A-Z]` equivalent inside a lookbehind. Each case is its own explicitly-cased
  // alternative instead.
  {
    pattern:
      /((?:(?<![A-Za-z])key(?![A-Za-z])|(?<=[a-z0-9])Key(?![A-Za-z])|(?<![A-Za-z])KEY(?![A-Za-z])))(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)/g,
    replace: '$1$2[redacted]',
  },
  // Authorization and Cookie/Set-Cookie header VALUES, including JSON/JS-object-quoted forms
  // (`{"Authorization":"Basic xyz"}`, `'Authorization': 'Basic xyz'`, `{"Cookie":"sid=abc"}`)
  // and any case (`COOKIE:`, `SET-COOKIE:`) -- the same separator/value shape as the key=value
  // pattern above, so an escaped or JSON-quoted header value redacts exactly like any other
  // credential field instead of only matching a bare `Name: value` line.
  {
    pattern: /\b(Authorization|(?:Set-)?Cookie)(\\?['"]?\s*:\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\n]+)/gi,
    replace: '$1$2[redacted]',
  },
  // Generic scheme (not just http/https) userinfo: mongodb+srv://, postgres://, redis://,
  // wss://… -- redacts up to the LAST unescaped `@` before the host (greedy `[^\s/]*` backtracks
  // to find it), so a raw `@` inside the password itself (`postgres://u:p@ss@host/db`) no longer
  // leaks a trailing fragment; an empty username (`redis://:pw@host`) is still allowed. Scheme
  // bounded to 31 chars against pathological input (no real scheme is anywhere near that long).
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]*:[^\s/]*@(?=[^\s/@]*(?:[/:?#\s]|$))/gi,
    replace: '$1[redacted]@',
  },
  // Gate-fixes security Medium finding (cycle 5, moved + bounded cycle 6): email addresses --
  // the omp log tail is far more likely than stderr to carry a provider account email from an
  // auth line. Moved to LAST: this used to run before the URL-userinfo pattern above and could
  // match `<rest-of-password>@host.tld` inside a URL login first, consuming the `@` the URL
  // pattern needed and leaving everything up to that point -- including most of the password --
  // unredacted (`redis://:Abc#def@cache.example.com` -> `redis://:Abc#[email]`). Character
  // classes bounded (local part, each domain label, and the TLD) against the same unbounded-
  // repetition cost flagged on long dotted/`a.`-repeated input; the other patterns here are
  // already bounded or linear.
  { pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g, replace: '[email]' },
]

/** Pure text transform: runs every pattern over `text` and returns the redacted result. Never
 * throws; a pattern that matches nothing leaves `text` unchanged. */
export function redactSecrets(text: string): string {
  let result = text
  for (const { pattern, replace } of PATTERNS) {
    result = result.replace(pattern, replace)
  }
  return result
}
