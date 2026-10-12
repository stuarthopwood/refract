import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { posix as posixPath, sep } from 'node:path';

/** Trailing-edge debounce window for `watchDirectory`'s own per-directory coalescing. Larger
 * than `PatchCoalescer`'s 50ms (`src/main/omp/patchCoalescer.ts`, which coalesces cheap in-memory
 * transcript ops): a burst here is a filesystem operation (a git checkout, a branch switch, an
 * editor save-with-backup-file dance) that can keep firing raw `fs.watch` events for longer than
 * a single UI frame, and each eventual re-list the caller runs (`fileExplorer.listDirectory`) does
 * real per-entry disk work (symlink classification, `fs.stat`) -- a wider window meaningfully cuts
 * duplicate re-lists during one multi-file operation while still reading as instant to a human
 * (FR-020 asks for "live," not sub-100ms). */
const WATCH_DEBOUNCE_MS = 200;

/** Returned by `watchDirectory`; the caller's one way to tear down a Session's watcher (for
 * example, when that Session is archived/deleted or the app is shutting down the watcher pool). */
export interface DirectoryWatchHandle {
  /** Stops watching and discards any not-yet-flushed debounced directories. Safe to call more
   * than once. */
  stop(): void;
}

/**
 * Watches `worktreeRoot`'s whole subtree and reports, via `onDirectoryChanged`, which single
 * directory (relative to `worktreeRoot`, POSIX `/`-separated regardless of platform -- the same
 * convention `FileTreeNode.path` already uses, data-model.md) needs re-listing. Debounced on a
 * `WATCH_DEBOUNCE_MS` trailing-edge timer, per affected directory, so a burst of raw OS events
 * against the same directory collapses into one callback call.
 *
 * research.md decision 5 (verbatim), the authoritative reasoning for the rename-ambiguity
 * handling and the debounce-not-poll design below:
 *
 * > File watcher: Node's `fs.watch({ recursive: true })` is available on Windows, but needs
 * > debouncing and a rename-ambiguity tolerance, not a polling fallback. `fs.watch`'s `recursive`
 * > option has shipped cross-platform (including win32) since Node 20; on Windows it is backed by
 * > `ReadDirectoryChangesW`, which can coalesce or reorder rapid successive writes and reports
 * > both "a file was created" and "a file was renamed" as the ambiguous `rename` event type
 * > (Node's own documented caveat) -- the watcher therefore treats every `rename` event as
 * > "re-list this event's directory," not "this specific path was deleted," and debounces a burst
 * > of events (e.g. a git checkout touching many files at once) into one re-list per affected
 * > directory on a short trailing-edge timer, rather than a tree rebuild per raw event. No
 * > polling fallback is specified: Windows is the only platform this app ships on, and
 * > `ReadDirectoryChangesW` coverage is unconditional there (unlike the inotify-depth limits
 * > recursive watch has on Linux, which motivate a polling fallback in cross-platform tools but
 * > do not apply here).
 *
 * This module's job stops at "watch, debounce, report which directory" -- it never calls
 * `fileExplorer.listDirectory`/`resolveInWorktree` itself (it has no Session registry access);
 * the caller (`src/main/ipc/fileExplorer.ts`) re-lists the reported directory through the
 * existing hardened path and emits `FILE_EXPLORER_PATCH`. A plain `'change'` event (content
 * modified, name unchanged) is queued the same way a `'rename'` is: `fs.watch` gives no
 * reliable way to tell, from here, whether a same-window `'change'` is independent of a
 * `'rename'` the OS coalesced away, and re-listing a directory that did not actually gain or
 * lose an entry is harmless (the caller's fresh listing is simply identical) where silently
 * skipping a genuine add/remove would not be.
 *
 * `.git` changes never queue a re-list (FR-007): any changed path with a `.git` path segment,
 * matched case-insensitively, is filtered out before it reaches the debounce set. `filename` is
 * `null` on the platforms/conditions Node documents as not always supplying it; that case falls
 * back to queuing the watched root's own top level (`''`) rather than crashing or dropping the
 * event silently.
 *
 * Never follows a symlink/junction itself: `recursive: true` watches the real on-disk tree as
 * `ReadDirectoryChangesW` reports it, and every path handed to `onDirectoryChanged` is passed
 * through from `fs.watch`'s own event, never constructed or resolved further here -- the
 * caller's `resolveInWorktree`-backed `listDirectory` re-validates containment on every call.
 */
export function watchDirectory(
  worktreeRoot: string,
  onDirectoryChanged: (relativePath: string) => void,
  debounceMs: number = WATCH_DEBOUNCE_MS
): DirectoryWatchHandle {
  const pendingDirectories = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    const directories = [...pendingDirectories];
    pendingDirectories.clear();
    for (const relativePath of directories) onDirectoryChanged(relativePath);
  };

  const queueDirectory = (relativePath: string): void => {
    pendingDirectories.add(relativePath);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, debounceMs);
  };

  const toRelativeDirectory = (filename: string | Buffer | null): string => {
    if (filename === null) return '';
    const text = typeof filename === 'string' ? filename : filename.toString();
    const normalized = text.split(sep).join('/');
    if (normalized.toLowerCase().split('/').includes('.git')) return '__ignore__';
    const parent = posixPath.dirname(normalized);
    return parent === '.' ? '' : parent;
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(worktreeRoot, { recursive: true }, (_eventType, filename) => {
      const relativeDirectory = toRelativeDirectory(filename);
      if (relativeDirectory === '__ignore__') return;
      queueDirectory(relativeDirectory);
    });
  } catch {
    // The worktree folder is gone or unreadable at watch-start time: nothing to watch. Returning
    // a usable no-op handle (rather than throwing) keeps a missing/recreated worktree from
    // crashing whatever is starting this Session's watcher.
  }

  return {
    stop(): void {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      pendingDirectories.clear();
      watcher?.close();
    }
  };
}
