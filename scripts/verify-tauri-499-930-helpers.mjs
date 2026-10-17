#!/usr/bin/env node
// Split out of verify-tauri-499-930.mjs (#806 file-size cap, caught live 2026-10-18 during gate
// round 1 on PR #953 -- the main script crossed 600 lines adding the round's own live checks).
// Kept alongside (not folded into) verify-tauri-scratch-helpers.mjs/verify-tauri-cdp.mjs: these
// are specific to THIS story's own live check, not generic across every verify-tauri-*.mjs --
// the bundle marker string, the scratch clone URL, and the resize handle's own drag simulation
// all name #499/#930 directly.
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { waitForCdpTarget, CdpSession, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';

const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

export async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-499-930: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Clones `stuarthopwood/refract` itself, shallow and read-only, into `dir` -- real PR data
 * without ever writing to a real repository. Returns `null` (never throws) if the clone fails
 * (offline, rate-limited) so the caller fails the run loudly instead of faking a pass. */
export function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-499-930: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

/** Asserts a #499/#930-only marker exists in the built renderer bundle, per
 * `refract-ui-lane-gate-checklist`'s own rule, before trusting anything else. Two independent,
 * story-only literals (never introduced by any other issue): the Filters disclosure's own
 * fixed element id, and the resize handle's own accessible name. `repoRoot` is the caller's own
 * `REPO_ROOT` -- this file has no `import.meta.url` of its own worth resolving a bundle path from. */
export function assertBundleContainsStory499930Marker(repoRoot) {
  const bundleRoot = path.join(repoRoot, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-tauri-499-930: no built renderer bundle at ${bundleRoot} -- run \`pnpm tauri build --debug --no-bundle\` first (the exe build below rebuilds it, but this static check runs before launch).`);
  }
  const grep = spawnSync_('node', ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    function* walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); }
        else if (entry.name.endsWith('.js')) yield full;
      }
    }
    let found = false;
    for (const file of walk(${JSON.stringify(bundleRoot)})) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('pull-request-filters-panel') && text.includes('Resize pull request list')) { found = true; break; }
    }
    console.log(found ? 'FOUND' : 'MISSING');
  `]);
  assert(grep.stdout.includes('FOUND'), '#499/#930-only marker (Filters panel id + resize handle aria-label) not found in the built renderer bundle -- the exe under test may not actually contain this story\'s code');
}

/** Real pointer drag of the resize handle (CDP `Input.dispatchMouseEvent` press/move/release --
 * no library drag helper exists in this harness; a bare click/release pair never engages
 * `react-resizable-panels`' own pointer-drag state machine the way a real OS drag does). Moves
 * in several small steps, matching how a real user's pointer is sampled, not one large jump.
 * Mirrors `verify-tauri-session-list-helpers.mjs`'s own `dragResizeHandleBy`: an initial hover
 * `mouseMoved` (no button) before the press, then each drag-step `mouseMoved` carries `buttons:
 * 1` (the bitmask of currently-held buttons CDP uses to synthesize a real `pointermove` with
 * the button still down) -- NOT `button: 'left'` (CDP's singular `button` field only names
 * which button triggered a press/release/click event; passing it on `mouseMoved` leaves no
 * button recorded as held, so `react-resizable-panels`' `pointermove` listener sees an
 * unpressed hover and ignores it for resizing, the bug that shipped here first). */
export async function dragHandleBy(cdp, handleFinderExpr, deltaX) {
  const rect = await cdp.evaluate(`(() => { const el = ${handleFinderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  assert(rect, `resize handle not found for drag: ${handleFinderExpr}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = rect.x + (deltaX * i) / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: rect.y, buttons: 1 });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + deltaX, y: rect.y, button: 'left', clickCount: 1 });
}
