// IPC handler for `sessions.revealFile` (issue #610): reveals a single file in the OS file
// explorer via `shell.showItemInFolder`. Deliberately NEVER `shell.openPath` -- that runs the
// file's own default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` an agent or tool wrote would execute),
// which is exactly the attack surface constitution V's "agent/tool/file output is untrusted"
// rule exists to close. The path comes straight from rendered chat text (a linkified file
// reference) -- main is the sole authority on containment; the renderer's own string checks
// (`linkify.ts`) are a cheap early-out, never trusted here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, notFound } from './util';

/** Windows reserved device names (case-insensitive, with or without a trailing extension) --
 * rejected as a path SEGMENT anywhere in the token, before any filesystem call ever touches it.
 * Quality-gate fix (round 2): also covers the console-handle aliases (`CONIN$`/`CONOUT$`),
 * superscript digit variants of `COM`/`LPT` Windows itself still recognises (`COM\u00b9`-`COM\u00b3`,
 * `LPT\u00b9`-`LPT\u00b3`), and trailing spaces/dots (`CON `, `NUL.`) -- none of these reach a real
 * file in practice (confirmed: `fs.realpath` returns ENOENT for every one), so this is defence in
 * depth, not the only thing standing between a reserved name and `shell.showItemInFolder`. */
const RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[1-9\u00b9\u00b2\u00b3])[ .]*(\.[^\\/]*)?$/i;

const MAX_SESSION_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;

export type ResolveInWorktreeResult =
  | { ok: true; realPath: string }
  | { ok: false; reason: 'outside-worktree' | 'file-missing' | 'worktree-missing' };

/** Resolves `token` (untrusted: agent/tool/model-authored chat text) against `worktreeRoot`,
 * proving containment rather than assuming it. Every string-only rejection below runs BEFORE any
 * filesystem call touches `token` -- a UNC path reaching `fs.realpath`/`shell.showItemInFolder`
 * can trigger an outbound SMB authentication attempt on Windows (NTLM hash leak) even without
 * ever actually opening anything, so these must never be deferred to "resolve first, check
 * after". Shared by the IPC handler below; kept exported so a future caller (e.g. a composer
 * image-path reader, issue #514) can reuse the exact same containment rule instead of a second
 * one-off implementation. */
export async function resolveInWorktree(worktreeRoot: string, token: string): Promise<ResolveInWorktreeResult> {
  // NUL bytes are invalid in any real path and some platform APIs mishandle them outright.
  if (token.includes('\0')) return { ok: false, reason: 'outside-worktree' };

  // UNC (`\\host\share`, `//host/share`) and device paths (`\\?\...`, `\\.\...`) all normalize to
  // a leading `//` once every backslash becomes a forward slash -- one check catches every form.
  if (token.replace(/\\/g, '/').startsWith('//')) return { ok: false, reason: 'outside-worktree' };

  // Any colon other than a single drive-letter prefix (`C:`) is rejected outright: this is what
  // blocks `javascript:`/`data:`/`mailto:`/any other scheme, and an NTFS alternate data stream
  // (`file.txt:Zone.Identifier`) -- the renderer's own `linkify.ts` already strips a trailing
  // `:line[:col]` suffix before ever calling this, so a legitimate token never reaches here with
  // one; this is the independent, non-renderer-trusting half of that same rule.
  const colonIndex = token.indexOf(':');
  if (colonIndex !== -1 && !(colonIndex === 1 && /^[A-Za-z]$/.test(token[0] ?? ''))) {
    return { ok: false, reason: 'outside-worktree' };
  }

  // Reserved device names, checked per path segment (so `foo/CON/bar.ts` is caught too).
  const segments = token.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => RESERVED_NAME_RE.test(segment))) {
    return { ok: false, reason: 'outside-worktree' };
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(worktreeRoot);
  } catch {
    return { ok: false, reason: 'worktree-missing' };
  }

  // Quality-gate fix (Code3/Verif3 Low, round 4): moved ABOVE `candidate`'s own computation --
  // round 3 put this after `const candidate = path.resolve(...)` while claiming the opposite in
  // its own comment and the PR body ("never handed to `path.resolve` at all"); there was no actual
  // filesystem effect (a drive-relative token was always rejected here, with no realpath call on
  // it either way), only the wording and ordering were wrong. Drive-relative on another drive
  // (`D:foo`, no separator after the drive letter) is rejected outright, now genuinely never
  // reaching `path.resolve` at all -- Node would otherwise resolve that shape against its own
  // process-wide "current directory on drive D" state, which this handler has no business
  // depending on. The earlier colon rule only ever matched a single-letter PREFIX (`C:`), so a
  // drive-relative token (which also starts `X:` but is NOT followed by a separator) reaches
  // here, not that rule.
  if (/^[A-Za-z]:(?![\\/])/.test(token)) return { ok: false, reason: 'outside-worktree' };

  // `candidate` is `path.resolve(resolvedRoot, token)` unconditionally (round 3 fix) --
  // `path.resolve` ignores `resolvedRoot` and returns an absolute `token` unchanged, so a
  // genuinely-absolute token is unaffected; a RELATIVE token (including one laden with `..`) is
  // normalised against the worktree root, collapsing any `..` segments.
  const candidate = path.resolve(resolvedRoot, token);
  const caseInsensitive = process.platform === 'win32';
  // Quality-gate fix (Sec4 Medium, round 5, pre-existing since round 2): Unicode `toLowerCase()`
  // folds `U+212A` (the Kelvin sign) to `'k'`, but NTFS does NOT treat `U+212A` as the same
  // character as `k`/`K` -- a real-fs probe confirmed a token spelled with `U+212A` in a path
  // segment passed this LEXICAL check as if it matched an ordinary `k`/`K` segment, even though it
  // names a DIFFERENT, sibling folder on disk. This lexical check is only a pre-filter (the real
  // boundary is the post-`realpath` check below, now fixed separately), so folding ASCII letters
  // only is still safe and correct here: it keeps the intended leniency (an ordinary differently-
  // cased token still passes this pre-filter) without folding any non-ASCII confusable pair.
  const foldCase = (value: string) => (caseInsensitive ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : value);
  const resolvedRootLower = foldCase(resolvedRoot);

  // Quality-gate fix (Verif3 Medium, round 4): when the Session's worktree path reaches its
  // files through a junction, symlink or 8.3 short-name segment, `resolvedRoot` above (already
  // realpath'd) differs from the UNRESOLVED path the agent's own cwd uses and so prints in every
  // absolute token it writes -- e.g. root `C:\Users\SHOPWO~1\wt` realpaths to
  // `C:\Users\shopwood\wt`, or a junction `alias` -> `wt`; the agent prints `alias\a.txt`, never
  // the realpath'd form. The lexical check below previously compared only against `resolvedRoot`,
  // so every one of those genuinely-legitimate absolute tokens was rejected as outside-worktree
  // (fails closed -- never an escape -- but still a functional false negative: a real, in-worktree
  // file the agent itself just printed the path to would never link). Fix: lexical containment
  // now accepts EITHER root -- `resolvedRoot` (realpath'd) or `unresolvedRoot` (`worktreeRoot`
  // normalised but never realpath'd, matching what the agent's own absolute paths look like).
  // The POST-realpath containment check below is against `resolvedRoot` only, unchanged -- a
  // junction/symlink escape (e.g. `alias\j\secret.txt` where `j` is a junction pointing outside
  // the worktree) is still caught there, because `fs.realpath` resolves `candidate` to its real,
  // final target before that check ever runs.
  const unresolvedRoot = path.resolve(worktreeRoot);
  const unresolvedRootLower = foldCase(unresolvedRoot);

  // Quality-gate fix (round 2, corrected round 3, extended round 4): a LEXICAL containment check
  // on the fully resolved, normalised `candidate` runs BEFORE `fs.realpath` ever touches it -- a
  // path outside the worktree is rejected here without ever resolving it (never probes an
  // arbitrary local path or drive, never lets the file-missing/outside-worktree split leak
  // whether something outside the worktree happens to exist). The remaining risk -- a
  // symlink/junction INSIDE the worktree that points outside it -- is exactly what `fs.realpath`
  // below still exists to catch; this lexical check alone cannot see through a symlink.
  const isContainedIn = (value: string, root: string) => value === root || value.startsWith(`${root}${path.sep}`);
  const candidateLower = foldCase(candidate);
  const lexicallyContained =
    isContainedIn(candidateLower, resolvedRootLower) || isContainedIn(candidateLower, unresolvedRootLower);
  if (!lexicallyContained) return { ok: false, reason: 'outside-worktree' };

  // Quality-gate fix (Sec3/Verif3 Low, round 4): a token that resolves to the worktree root
  // ITSELF (`''` or `.`) was previously accepted and would reveal the whole worktree folder --
  // harmless (linkify never produces these tokens, and it is still the agent's own worktree), but
  // not a real file reference either. Rejected as `file-missing` rather than silently succeeding.
  if (candidateLower === resolvedRootLower || candidateLower === unresolvedRootLower) {
    return { ok: false, reason: 'file-missing' };
  }

  let resolvedTarget: string;
  try {
    // `fs.realpath` (not `fs.stat` first) so a symlink/junction inside the worktree that points
    // OUTSIDE it is resolved to its real, final target before the containment check below ever
    // runs -- checking containment against the unresolved candidate path would miss exactly that
    // escape.
    resolvedTarget = await fs.realpath(candidate);
  } catch {
    return { ok: false, reason: 'file-missing' };
  }

  // Quality-gate fix (Sec4 Medium, round 5): NO case folding at all here -- this is the REAL,
  // final-target containment check, the actual security boundary. `resolvedTarget` and
  // `resolvedRoot` are both already fully realpath'd, and a real-fs probe confirmed
  // `fs.realpath` always returns the canonical ON-DISK casing regardless of the casing a token
  // was written in (even an all-caps token realpaths to the file's own true casing) -- so
  // comparing the two realpath'd strings directly, with no transform, is both sufficient (two
  // paths naming the same on-disk location always realpath to byte-identical strings) and
  // necessary (ANY case-folding transform here -- including the ASCII-only fold used for the
  // lexical pre-check above, and especially Unicode `toLowerCase()`'s `U+212A`-to-`'k'` collapse
  // -- can make two DIFFERENT on-disk paths compare equal, exactly the Kelvin-sign bypass this
  // fixes). Checked against `resolvedRoot` only (never `unresolvedRoot`, which was never
  // realpath'd and so is not a safe thing to compare a realpath'd value against here).
  const contained =
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
  if (!contained) return { ok: false, reason: 'outside-worktree' };

  const stat = await fs.stat(resolvedTarget).catch(() => null);
  if (!stat) return { ok: false, reason: 'file-missing' };

  return { ok: true, realPath: resolvedTarget };
}

export function registerFilesIpc(manager: SessionManager): void {
  ipcMain.handle(
    IPC_REQUESTS.SESSIONS_REVEAL_FILE,
    async (_event, sessionId: unknown, token: unknown): Promise<Result<void>> => {
      if (typeof sessionId !== 'string' || typeof token !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.SESSIONS_REVEAL_FILE} expects a string sessionId and a string path`);
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || token.length > MAX_TOKEN_LENGTH) {
        return invalidArgument(`${IPC_REQUESTS.SESSIONS_REVEAL_FILE} rejected an oversized sessionId or path`);
      }
      const session = manager.registry.getSession(sessionId);
      if (!session) return notFound(`Session not found: ${sessionId}`);

      const resolved = await resolveInWorktree(session.worktreePath, token);
      if (!resolved.ok) {
        if (resolved.reason === 'worktree-missing') {
          return { ok: false, error: { code: 'worktree-missing', message: `Worktree missing: ${session.worktreePath}` } };
        }
        if (resolved.reason === 'file-missing') {
          return { ok: false, error: { code: 'file-missing', message: `Couldn't find that file in this Session's worktree` } };
        }
        return { ok: false, error: { code: 'outside-worktree', message: `That path is outside this Session's worktree` } };
      }

      // Never logs the resolved path itself, the same convention `openExternalSafe` follows.
      shell.showItemInFolder(resolved.realPath);
      return { ok: true, value: undefined };
    }
  );
}
