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

/** Every TEXT-ONLY rejection a token must pass before any filesystem call ever touches it: NUL
 * bytes; UNC/device paths (`\\host\share`, `\\?\...`, `\\.\...` -- all normalise to a leading
 * `//` once backslashes become forward slashes); any colon other than a single drive-letter
 * prefix (blocks `javascript:`/`data:`/an NTFS alternate data stream, and is also how a
 * drive-relative token like `D:foo` is caught, one line below); Windows reserved device names
 * per path segment. Extracted (PR #671 gate round 2 fix, security-auditor/code-reviewer/
 * verification/a11y HIGH) so `resolveNoFollow`'s own per-hop link-target check below runs the
 * IDENTICAL set of checks a top-level token gets -- the previous round only ever UNC-checked a
 * link's own first-hop target text, so a SECOND link in the chain (`a -> b`, `b ->
 * \\attacker\share`) reached `fs.realpath` unchecked and opened an outbound SMB/NTLM connection
 * with no click. Exported (#514/#432) for the shared attachment-path reader in `attachments.ts`
 * -- the single source of truth so a path-based image attach can never apply a narrower set of
 * checks than `resolveInWorktree` does.
 *
 * PR #723 gate round 1 fix (Sec1 LOW): the colon check above only ever looked at the FIRST colon
 * (needed so a legitimate `C:\...` drive prefix still passes) -- a token with a SECOND colon
 * after the drive letter, e.g. `C:\tmp\host.txt:hidden.png` (an NTFS alternate data stream),
 * slipped through: `colonIndex` found the drive-letter colon at index 1, matched the allowed
 * shape, and the function returned early without ever noticing the stream marker later in the
 * string. Checking `value.indexOf(':', 2)` as a SEPARATE condition closes this: any colon from
 * index 2 onward (i.e. anywhere after a drive letter has already been allowed) is rejected,
 * regardless of what the first colon looked like. */
export function isUnsafeToken(value: string): boolean {
  if (value.includes('\0')) return true;
  if (value.replace(/\\/g, '/').startsWith('//')) return true;
  const colonIndex = value.indexOf(':');
  if (colonIndex !== -1 && !(colonIndex === 1 && /^[A-Za-z]$/.test(value[0] ?? ''))) return true;
  if (value.indexOf(':', 2) !== -1) return true;
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return true;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => RESERVED_NAME_RE.test(segment));
}

// Bounds how many link substitutions `resolveNoFollow` will walk through before rejecting outright
// -- without this, a cycle (`a -> b`, `b -> a`) would loop forever.
const MAX_LINK_HOPS = 32;

const MAX_SESSION_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;

export type ResolveInWorktreeResult =
  | { ok: true; realPath: string }
  | { ok: false; reason: 'outside-worktree' | 'file-missing' | 'worktree-missing' };

/** Walks `relativeSuffix` (already lexically proven to resolve under `root`, which is always
 * ALREADY realpath'd) one path segment at a time, using `fs.lstat` -- never `fs.stat`/
 * `fs.realpath` -- on each successive prefix. `fs.lstat` reports whether that ONE segment is
 * itself a link WITHOUT ever following it. A segment that is not a link is simply descended
 * into: its parent (`current`) has already been proven link-free by this same walk, so this one
 * extra path component is the only thing the OS resolves that has not already been vetted. A
 * segment that IS a link has its raw, unfollowed target read with `fs.readlink` and checked
 * exactly like a fresh token (`isUnsafeToken`, plus lexical containment under `root`) -- a
 * UNC/device target, or one that escapes `root`, is rejected immediately, the network never
 * touched.
 *
 * PR #671 gate round 2 fix (security-auditor/code-reviewer/verification/a11y HIGH, reproduced
 * live on this machine): a safe-looking target is NOT assumed to be link-free just because it is
 * lexically inside `root` -- the walk RESTARTS from `root` with the target's own relative
 * segments prepended to whatever original segments were still pending, rather than resuming from
 * the target directly. A chain (`a` -> in-root `b` -> `\\attacker\share`) or a link sitting in a
 * MIDDLE segment of a path (`a2` -> `b\System32`, where `b` is itself a link) both get exactly
 * the same one-segment-at-a-time scrutiny this way: the previous round's fix substituted the
 * target and kept walking the ORIGINAL segments directly against it, which is exactly the "hand
 * the OS a multi-component path through an unverified link" mistake this function exists to
 * avoid -- Windows resolves EVERY segment of a path string during an ordinary `CreateFileW`/
 * `lstat`-equivalent call, including reparse points that are not the path's own final component,
 * so a single `fs.lstat`/`fs.readlink` call must never be given more than one new, unverified
 * path component at a time.
 *
 * PR #671 gate round 3 fix (security-auditor/code-reviewer MEDIUM, reproduced live): a link's
 * target is checked against EITHER `root` (realpath'd) OR `unresolvedRoot` (the Session's own
 * recorded worktree path, never realpath'd) -- not `root` alone. When the worktree itself is
 * reached through a junction or an 8.3 short-name alias, a tool run from that alias (pnpm writes
 * absolute junction targets from its own cwd) writes an absolute link target in the ALIAS form,
 * which only matches `unresolvedRoot` lexically, never `root`. Checking `root` alone rejected
 * every such legitimate in-worktree link as `outside-worktree` -- fails closed (never an escape)
 * but a real functional regression, the exact false-negative class issue #610's own round-4
 * Verif3 fix already solved once for top-level TOKENS; this extends the same fix to a link
 * TARGET found mid-walk. Whichever root the target matches, the walk still restarts from `root`
 * (the realpath'd one) -- never from `unresolvedRoot` -- so the containment guarantee is
 * unchanged; only the ACCEPT decision gained the second root.
 *
 * Capped at `MAX_LINK_HOPS` link substitutions to reject a cycle (`a -> b -> a`) rather than loop
 * forever. Only once every segment has been consumed with no link remaining is the resulting path
 * safe to hand to `fs.realpath` (canonicalises casing/8.3 short names; nothing is left in the
 * path for it to follow).
 *
 * **Accepted residual risk (PR #671 gate round 3, security-auditor/verification LOW, NOT closed,
 * documented rather than silently assumed away)**: a TOCTOU window exists between this walk's
 * last `fs.lstat` and the caller's own final `fs.realpath` -- a link swapped into an
 * already-checked segment in that window could still be followed by that `fs.realpath` call. The
 * post-realpath containment check still rejects the RESULT, so this is not an escape, but a
 * target that is itself a UNC path could still trigger an outbound SMB/NTLM attempt during that
 * window before the rejection lands. Winning this race requires a process with write access to
 * the worktree while a listing is in flight -- the same local attacker who can already reach a
 * UNC path directly, so this is accepted, not mitigated, for Slice 1. */
async function resolveNoFollow(
  root: string,
  unresolvedRoot: string,
  relativeSuffix: string,
  caseInsensitive: boolean
): Promise<{ ok: true; path: string } | { ok: false; reason: 'outside-worktree' | 'file-missing' }> {
  const fold = (value: string) => (caseInsensitive ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : value);
  const isContainedIn = (value: string, base: string) => value === base || value.startsWith(`${base}${path.sep}`);
  const foldedRoot = fold(root);
  const foldedUnresolvedRoot = fold(unresolvedRoot);

  let current = root;
  let queue = relativeSuffix.split(/[\\/]+/).filter(Boolean);
  let hops = 0;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    const next = path.join(current, segment);
    let lst;
    try {
      lst = await fs.lstat(next);
    } catch {
      return { ok: false, reason: 'file-missing' };
    }
    if (!lst.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return { ok: false, reason: 'outside-worktree' };
    let rawTarget: string;
    try {
      rawTarget = await fs.readlink(next);
    } catch {
      return { ok: false, reason: 'file-missing' };
    }
    if (isUnsafeToken(rawTarget)) return { ok: false, reason: 'outside-worktree' };
    const targetAbs = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(current, rawTarget);
    const foldedTarget = fold(targetAbs);
    const matchedRoot = isContainedIn(foldedTarget, foldedRoot)
      ? root
      : isContainedIn(foldedTarget, foldedUnresolvedRoot)
        ? unresolvedRoot
        : null;
    if (matchedRoot === null) return { ok: false, reason: 'outside-worktree' };
    // Restart from `root` (always the realpath'd one, regardless of which root the target
    // matched): the target's OWN path may contain further unverified links in its OWN
    // intermediate segments, not only at its final component -- prepending its relative segments
    // back onto the queue and resetting `current` to `root` gives every one of them the SAME
    // one-at-a-time scrutiny, rather than trusting `targetAbs` as a safe base to resolve further
    // (see this function's own doc comment).
    queue = [...path.relative(matchedRoot, targetAbs).split(/[\\/]+/).filter(Boolean), ...queue];
    current = root;
  }
  // PR #671 gate round 3 fix (verification LOW): a link that resolves, through however many
  // hops, back to the worktree ROOT itself (`loop -> '.'`) must be rejected the same way a
  // top-level token equal to the root already is (the check just above `resolveNoFollow`'s own
  // call site in `resolveInWorktree`) -- otherwise `revealFile` would show the whole worktree
  // folder, and the explorer would render an endlessly re-enterable `loop` row.
  if (current === root) return { ok: false, reason: 'file-missing' };
  return { ok: true, path: current };
}

/** PR #723 gate round 1 fix (Sec1/Verif1 HIGH, reproduced live: a symlink to `\\127.0.0.1\C$\...`
 * made `fs.realpath` take ~7.8s and open a real SMB session; a chained/middle-segment symlink to
 * UNC behaved the same way). Generalises `resolveNoFollow` above for an ABSOLUTE token with NO
 * containment boundary (`attachments.ts`'s own absolute-path branch, #514/#432): walks from the
 * token's own drive root one segment at a time via `fs.lstat`, exactly like `resolveNoFollow`,
 * but never checks containment against any root -- there is none here (research.md Decision 11:
 * a user-initiated absolute path is read directly, not required to stay inside any worktree). A
 * link's target is still vetted for its own TEXT shape (`isUnsafeToken`: UNC/device/ADS/
 * reserved-name rejection) before ever being followed, exactly as a top-level token is -- this is
 * what was MISSING before this fix: the absolute branch previously handed the token straight to
 * `fs.realpath`, which follows every link (including to a UNC target) in ONE native call with no
 * chance to vet an intermediate hop. A target on a different drive restarts the walk from ITS
 * OWN root, the same "never trust `targetAbs` as a safe base, re-walk every one of its segments"
 * rule `resolveNoFollow`'s own doc comment describes. */
export async function resolveNoFollowUnrooted(absoluteToken: string): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-found' }> {
  const tokenRoot = path.parse(absoluteToken).root;
  let current = tokenRoot;
  let queue = absoluteToken.slice(tokenRoot.length).split(/[\\/]+/).filter(Boolean);
  let hops = 0;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    const next = path.join(current, segment);
    let lst;
    try {
      lst = await fs.lstat(next);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    if (!lst.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return { ok: false, reason: 'not-found' };
    let rawTarget: string;
    try {
      rawTarget = await fs.readlink(next);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    if (isUnsafeToken(rawTarget)) return { ok: false, reason: 'not-found' };
    const targetAbs = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(current, rawTarget);
    const targetRoot = path.parse(targetAbs).root;
    queue = [...targetAbs.slice(targetRoot.length).split(/[\\/]+/).filter(Boolean), ...queue];
    current = targetRoot;
  }
  return { ok: true, path: current };
}

/** Resolves `token` (untrusted: agent/tool/model-authored chat text) against `worktreeRoot`,
 * proving containment rather than assuming it. Every string-only rejection below runs BEFORE any
 * filesystem call touches `token` -- a UNC path reaching `fs.realpath`/`shell.showItemInFolder`
 * can trigger an outbound SMB authentication attempt on Windows (NTLM hash leak) even without
 * ever actually opening anything, so these must never be deferred to "resolve first, check
 * after". Shared by the IPC handler below; kept exported so a future caller (e.g. a composer
 * image-path reader, issue #514) can reuse the exact same containment rule instead of a second
 * one-off implementation. */
export async function resolveInWorktree(worktreeRoot: string, token: string): Promise<ResolveInWorktreeResult> {
  // Every text-only rejection (NUL bytes, UNC/device paths, a colon other than a drive prefix,
  // a drive-relative token, Windows reserved device names per segment) -- see `isUnsafeToken`'s
  // own doc comment, shared with `resolveNoFollow`'s per-hop link-target check below so neither
  // ever runs a narrower set of checks than the other.
  if (isUnsafeToken(token)) return { ok: false, reason: 'outside-worktree' };

  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(worktreeRoot);
  } catch (err) {
    // Gate round 7 fix (Sec7/Code7/A11y7/Verif7 Medium, mirrors fileExplorer.ts's
    // `resolveListTarget`): only `ENOENT`/`ENOTDIR` actually mean the worktree root is gone; a
    // transient failure (EACCES/EBUSY/EMFILE -- AV scan, indexer, a brief delete-pending window)
    // reused this same `worktree-missing` reason, which the file-explorer watcher treats as
    // FATAL (stop + reset the whole tree) for what might resolve itself on the very next read.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'worktree-missing' };
    return { ok: false, reason: 'file-missing' };
  }

  // `candidate` is `path.resolve(resolvedRoot, token)` unconditionally (round 3 fix) --
  // `path.resolve` ignores `resolvedRoot` and returns an absolute `token` unchanged, so a
  // genuinely-absolute token is unaffected; a RELATIVE token (including one laden with `..`) is
  // normalised against the worktree root, collapsing any `..` segments. (The drive-relative
  // check this comment used to describe separately is now folded into `isUnsafeToken` above,
  // so a token such as `D:foo` is already rejected before `resolvedRoot` is even computed.)
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
  // The POST-walk containment check below is against `resolvedRoot` only, unchanged -- a
  // junction/symlink escape (e.g. `alias\j\secret.txt` where `j` is a junction pointing outside
  // the worktree) is still caught there, because `resolveNoFollow` (below) resolves every link
  // along `candidate`'s path, one hop at a time, to its real, final target before that check ever
  // runs.
  const unresolvedRoot = path.resolve(worktreeRoot);
  const unresolvedRootLower = foldCase(unresolvedRoot);

  // Quality-gate fix (round 2, corrected round 3, extended round 4): a LEXICAL containment check
  // on the fully resolved, normalised `candidate` runs BEFORE `resolveNoFollow`/`fs.realpath`
  // ever touch it -- a path outside the worktree is rejected here without ever resolving it
  // (never probes an arbitrary local path or drive, never lets the file-missing/outside-worktree
  // split leak whether something outside the worktree happens to exist). The remaining risk -- a
  // symlink/junction INSIDE the worktree that points outside it -- is exactly what
  // `resolveNoFollow` below still exists to catch; this lexical check alone cannot see through a
  // symlink.
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

  // Quality-gate fix (PR #671 gate round 2, security-auditor/code-reviewer/verification/a11y
  // HIGH): `candidate` is NEVER handed to `fs.realpath`/`fs.stat` directly any more -- that
  // follows every link along the way in one native call, with no chance to vet an intermediate
  // hop first. `resolveNoFollow` walks it one segment at a time instead (see its own doc
  // comment), substituting and re-vetting any link's target before the walk continues, so a
  // symlink/junction chain or a link sitting in a MIDDLE path segment is caught before ever
  // reaching an unvetted target -- not only a link that is the token's own final component.
  const relativeSuffix = isContainedIn(candidateLower, resolvedRootLower)
    ? path.relative(resolvedRoot, candidate)
    : path.relative(unresolvedRoot, candidate);
  const walked = await resolveNoFollow(resolvedRoot, unresolvedRoot, relativeSuffix, caseInsensitive);
  if (!walked.ok) return { ok: false, reason: walked.reason };

  let resolvedTarget: string;
  try {
    // Safe now: every segment of `walked.path` has already been individually vetted and had any
    // link substituted (`resolveNoFollow`) -- nothing is left in it for `fs.realpath` to follow.
    // This call only canonicalises casing/8.3 short names, exactly what it always did.
    resolvedTarget = await fs.realpath(walked.path);
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

// `containsGitSegment` moved to `../fs/paths` (PR #671 gate round 4 fix, Medium: a git-status
// reader importing from this IPC-handler module had no cycle but backwards layering); this file
// never called it itself and no longer imports it -- `fileExplorer.ts` and `git/status.ts` each
// import it directly from `fs/paths` now.

/** Shared by every caller of `resolveInWorktree` (this file's own `revealFile` handler and
 * `fileExplorer.ts`'s `listDirectory`) to map a `!ok` result to the same three error codes and
 * plain-English messages -- never a real filesystem path (constitution V: never leak one into a
 * message a screen reader or log could surface). PR #671 gate round 2 fix (security-auditor/
 * code-reviewer/a11y/verification MEDIUM): the `worktree-missing` message used to embed the
 * Session's absolute worktree path, directly contradicting this very comment -- the file
 * explorer panel then read it aloud via `role="alert"`. No longer takes a `worktreePath`
 * parameter at all, so a future caller cannot reintroduce the same mistake by passing one back
 * in. `noun` lets each call site say "file" or "folder" without a second, drifting copy of this
 * mapping (DRY fix, PR #671 gate round 1, code-reviewer). */
export function resolveErrorResult(
  reason: Exclude<ResolveInWorktreeResult, { ok: true }>['reason'],
  noun: 'file' | 'folder'
): Result<never> {
  if (reason === 'worktree-missing') {
    return { ok: false, error: { code: 'worktree-missing', message: `This Session's worktree folder no longer exists` } };
  }
  if (reason === 'file-missing') {
    return { ok: false, error: { code: 'file-missing', message: `Couldn't find that ${noun} in this Session's worktree` } };
  }
  return { ok: false, error: { code: 'outside-worktree', message: `That path is outside this Session's worktree` } };
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
      if (!resolved.ok) return resolveErrorResult(resolved.reason, 'file');

      // Never logs the resolved path itself, the same convention `openExternalSafe` follows.
      shell.showItemInFolder(resolved.realPath);
      return { ok: true, value: undefined };
    }
  );
}
