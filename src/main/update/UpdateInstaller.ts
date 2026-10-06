// Update download, checksum verification (spec 006 FR-014, research.md decision 4): downloads
// the available release's installer and checksum assets via `gh release download` (the
// developer's own signed-in credential, never a stored token), recomputes the installer's
// SHA-256 with Node's built-in `crypto`, and only persists `phase: 'downloaded'` on a match.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { ghRaw } from '../github/gh';
import type { UpdateStateStore } from '../store/updateState';

// research.md decision 8: the same private repository UpdateChecker.ts reads from.
const REPO = 'stuarthopwood/refract';

/** contracts/ipc.md's two documented errors for `updates.install()`; any failure past the
 * `'available'` precondition check (a network failure, a missing asset, or a real digest
 * mismatch) is reported as `checksum-mismatch` -- the contract defines no finer-grained code for
 * this call, and `UpdateState.lastError` (via `updates:state-changed`/`getState`) still carries
 * the specific, actionable reason for the badge UI. */
export class UpdateError extends Error {
  readonly code: 'update-unavailable' | 'checksum-mismatch';
  constructor(code: 'update-unavailable' | 'checksum-mismatch', message: string) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

/** `updates.install()` (contracts/ipc.md): awaits the whole download and checksum verification
 * for the release named by the current `available` state before resolving; persists
 * `'downloading'` immediately (so `updates:state-changed` can drive a progress indicator before
 * this promise ever resolves), then `'downloaded'` with `installerPath` on a verified match, or
 * `'failed'` with `lastError` otherwise (FR-014). */
export async function downloadUpdate(store: UpdateStateStore): Promise<void> {
  const state = store.get();
  if (state.phase !== 'available' || !state.availableVersion) {
    throw new UpdateError('update-unavailable', 'No update is available to install.');
  }
  const tagName = `v${state.availableVersion}`;
  await store.update({ phase: 'downloading' });

  const cwd = app.getPath('userData');
  const updatesDir = path.join(cwd, 'updates');
  try {
    // A previous failed attempt's leftovers are never mistaken for this one's fresh pair --
    // updatesDir is always `<userData>/updates`, never a caller-supplied or empty path.
    await fs.rm(updatesDir, { recursive: true, force: true });
    await fs.mkdir(updatesDir, { recursive: true });

    const result = await ghRaw(cwd, [
      'release',
      'download',
      tagName,
      '--repo',
      REPO,
      '--pattern',
      '*.exe',
      '--pattern',
      '*.sha256',
      '--dir',
      updatesDir,
      '--clobber'
    ]);
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || 'gh release download failed.').trim());
    }

    const entries = await fs.readdir(updatesDir);
    const installerName = entries.find((name) => name.toLowerCase().endsWith('.exe'));
    const checksumName = entries.find((name) => name.toLowerCase().endsWith('.sha256'));
    if (!installerName || !checksumName) {
      throw new Error('The downloaded release is missing its installer or checksum file.');
    }
    const installerPath = path.join(updatesDir, installerName);
    const checksumPath = path.join(updatesDir, checksumName);

    const expected = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const actual = createHash('sha256').update(await fs.readFile(installerPath)).digest('hex');
    if (!expected || actual !== expected) {
      // Both paths are always children of updatesDir (`<userData>/updates`), never derived
      // from caller input.
      await fs.rm(installerPath, { force: true });
      await fs.rm(checksumPath, { force: true });
      throw new Error('The downloaded installer did not match its published checksum.');
    }

    await store.update({ phase: 'downloaded', installerPath, lastError: undefined });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await store.update({ phase: 'failed', lastError: detail });
    throw new UpdateError('checksum-mismatch', detail);
  }
}
