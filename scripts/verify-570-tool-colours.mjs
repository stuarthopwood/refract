#!/usr/bin/env node
// Live CDP check for #570 (tool row colour treatment) against a real `omp` with scratch
// cwd/worktree/REFRACT_DATA_DIR (spends a few model tokens on echo-only prompts). Rebuild right
// before running, and assert `hideDetailWhenOpen` is in the built bundle so the exe matches the commit.
// Turns: (a) three bash calls, #2 failing and #3 slow; (b) a solo failing call; (c) a stopped slow
// call, diagnostic only, since a graceful Stop is not what produces 'interrupted' (a died process).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  getAccessibleNameAndRole,
  switchTheme,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Requires the shared CARGO_TARGET_DIR; never falls back to a worktree-local src-tauri/target (#946).
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// Overridable; defaults to a fresh timestamped temp folder so reruns never mix screenshots.
const SHOTS_DIR = process.env.REFRACT_570_SHOTS_DIR || path.join(tmpdir(), 'refract-570-gate1-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const TURN_A_PROMPT =
  "Make exactly THREE separate bash tool calls, strictly in this order, waiting for each one to finish before starting the next: first run exactly `sleep 1 && echo t570-one`, second run exactly `exit 9` (which deliberately fails with no output), third run exactly `sleep 8 && echo t570-three` (a longer sleep, to widen the window where the group is still running with one already-failed member). After all three finish, reply with exactly the single word 't570a' and nothing else.";
const TURN_B_PROMPT =
  "Make exactly ONE bash tool call: run exactly `ls /definitely-not-a-real-path-570-live` (it will fail). Wait for it to finish. Then reply with exactly the single word 't570b' and nothing else.";
const TURN_C_PROMPT =
  "Make exactly ONE bash tool call: run exactly `sleep 20`. Then reply with exactly the single word 't570c' and nothing else.";
const TURN_A_SENTINEL = 't570a';
const TURN_B_SENTINEL = 't570b';
// Matches a `ToolGroupRow`/solo header by its "bash" label (or "bash ×N", #632), falling back to a
// label-less button whose summary starts with "$ " (`commandRowText`).
const BASH_HEADER_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button')).filter((el) => {
    const label = el.querySelector('[data-slot="collapsed-line-label"]');
    if (label) return /^Ran(\\s*\\u00d7\\d+)?$/.test(label.textContent.trim());
    const s = el.querySelector('span.min-w-0.flex-1');
    return s ? /^\\$ /.test((s.textContent || '').trim()) : false;
  })`;

async function countBashHeaders(cdp) {
  return cdp.evaluate(`(${BASH_HEADER_FINDER}).length`);
}

async function clickBashHeaderAt(cdp, index) {
  await cdp.click(`(${BASH_HEADER_FINDER}).at(${index})`);
}

async function setBashHeaderExpanded(cdp, index, wantOpen) {
  const isOpen = await cdp.evaluate(`(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === 'true'`);
  if (isOpen === wantOpen) return;
  await clickBashHeaderAt(cdp, index);
  await cdp.waitFor(
    `(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === '${wantOpen}'`,
    { timeoutMs: 10_000, label: `bash header ${index} aria-expanded=${wantOpen}` },
  );
}

/** Reads the real computed colour of a header's icon, label, summary (M2's error-colour restore
 * for a label-less command-style row), and (if present) its linked Error line -- decisions 1-6.
 * Never guesses from class names: every value is `getComputedStyle(...).color`. */
async function readHeaderColours(cdp, index) {
  return cdp.evaluate(`(() => {
    const header = (${BASH_HEADER_FINDER}).at(${index});
    if (!header) return null;
    const icon = header.querySelector('span.flex svg, span > svg');
    const label = header.querySelector('[data-slot="collapsed-line-label"]');
    const summary = header.querySelector('span.min-w-0.flex-1');
    const describedby = header.getAttribute('aria-describedby');
    const detail = describedby ? document.getElementById(describedby) : null;
    const metaFailed = Array.from(header.querySelectorAll('span')).find((s) => /\\d+ failed/.test(s.textContent));
    return {
      iconColor: icon ? getComputedStyle(icon).color : null,
      labelColor: label ? getComputedStyle(label).color : null,
      labelText: label ? label.textContent.trim() : null,
      summaryColor: summary ? getComputedStyle(summary).color : null,
      detailText: detail ? detail.textContent.trim() : null,
      detailColor: detail ? getComputedStyle(detail).color : null,
      detailId: detail ? detail.id : null,
      ariaDescribedby: describedby,
      metaFailedText: metaFailed ? metaFailed.textContent.trim() : null,
      metaFailedColor: metaFailed ? getComputedStyle(metaFailed).color : null,
    };
  })()`);
}


// `hideDetailWhenOpen` (CollapsedLine.tsx) only exists from this story's commits, so finding it in the
// built bundle proves the exe contains #570's code.
function assertBundleContainsStory570Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsStory570Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('hideDetailWhenOpen')) {
      console.log(`verify-570: confirmed #570-only marker 'hideDetailWhenOpen' present in the built renderer bundle (${file}).`);
      return;
    }
  }
  throw new Error("assertBundleContainsStory570Marker: 'hideDetailWhenOpen' not found in any built renderer asset -- this build does not contain #570's code.");
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = []; // Wrong measured values -- ALWAYS fails the run. Never a graceful skip.
  const notExercised = []; // Genuine skips only (timing, an optional path not reached).
  let exeHash = null;
  let gitHeadSha = null;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-570-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-570-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-570-repo-')), 'verify-570-tool-colours');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-570-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-570-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-570: git HEAD ${gitHeadSha}`);
    console.log(`verify-570: data dir ${dataDir}`);
    console.log(`verify-570: shots dir ${SHOTS_DIR}`);
    console.log(`verify-570: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-570' });
    assertBundleContainsStory570Marker();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-570: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-570');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled',
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    const approvalPillLabel = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode')); return b ? b.getAttribute('aria-label') : null; })()`);
    if (!approvalPillLabel || !approvalPillLabel.startsWith('Auto')) {
      throw new Error(`verify-570: seeded settings.json approvalMode:"auto" did not take effect -- the Approval pill reads "${approvalPillLabel}".`);
    }
    findings.push(`Scratch Session launched already in Auto approval mode (pill reads "${approvalPillLabel}").`);

    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    let midRunCapture = null;
    let midRunGenuine = false;
    try {
      // Mid-run means the header icon is still the spinner (`animate-spin`); "fewer than 3 items"
      // also occurs between calls, where status is correctly 'error'.
      await cdp.waitFor(
        `(() => { const h = (${BASH_HEADER_FINDER})[0]; if (!h) return false; const icon = h.querySelector('span.flex svg, span > svg'); const spinning = icon && getComputedStyle(icon).animationName !== 'none'; return spinning && /\\d+ failed/.test(h.textContent); })()`,
        { timeoutMs: 15_000, label: 'Group header still spinning (a member genuinely in flight) while meta already shows a failed count' },
      );
      midRunCapture = await readHeaderColours(cdp, 0);
      midRunGenuine = true;
      await cdp.screenshot(path.join(SHOTS_DIR, '00-dark-running-with-failed-member.png'));
    } catch {
      notExercised.push('Could not catch the EXACT instant the group was still spinning (a member genuinely in flight) with a failed count already showing -- real model/tool timing is narrow here; the settled screenshot and the code\'s own `status` ternary (any item running always wins, unmodified by #570) are the evidence for this path instead.');
    }

    try {
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_A_SENTINEL}/g) ?? []).length >= 2; })()`,
        { timeoutMs: 180_000, label: 'Turn (a) finished (assistant echoed the sentinel back)' },
      );
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-failure.png'));
      const html = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`).catch(() => '');
      writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript-onfailure.html'), html);
      throw err;
    }
    const turnATranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript.html'), turnATranscriptHtml);

    const headerCountAfterA = await countBashHeaders(cdp);
    if (headerCountAfterA < 1) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-no-group.png'));
      throw new Error(`verify-570: expected at least 1 bash header after turn (a), found ${headerCountAfterA} -- see turn-a-transcript.html`);
    }
    if (headerCountAfterA !== 1) failures.push(`Expected exactly 1 bash ToolGroupRow header after turn (a) (Auto mode set), found ${headerCountAfterA}.`);

    const groupColoursSettled = await readHeaderColours(cdp, 0);
    const neutralColor = await cdp.evaluate(`(() => { const probe = document.createElement('span'); probe.className = 'text-muted-foreground'; probe.style.position = 'fixed'; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
    const errorColor = await cdp.evaluate(`(() => { const probe = document.createElement('span'); probe.className = 'text-severity-error'; probe.style.position = 'fixed'; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
    findings.push(`Live colour probes (Dark theme): --muted-foreground resolves to ${neutralColor}; --severity-error resolves to ${errorColor}.`);

    if (midRunCapture && midRunGenuine) {
      if (midRunCapture.labelColor === errorColor) failures.push(`Mid-run (header icon still spinning, a member genuinely in flight): header label already painted the error colour (${midRunCapture.labelColor}) -- decision 12 requires the header stay neutral until the group SETTLES.`);
      else findings.push(`Mid-run (header icon confirmed still spinning): header label stayed neutral (${midRunCapture.labelColor}) while one member had already failed (decision 12, running beats failed in the worst-state order).`);
      if (!midRunCapture.metaFailedText) failures.push('Mid-run: no "N failed" text found in the meta slot while one member had already failed -- decision 12 requires it visible at once, even mid-run.');
      else if (midRunCapture.metaFailedColor !== errorColor) failures.push(`Mid-run: "${midRunCapture.metaFailedText}" meta text measured ${midRunCapture.metaFailedColor}, expected the error colour ${errorColor} (decision 12).`);
      else findings.push(`Mid-run: "${midRunCapture.metaFailedText}" already shows in the error colour while the group is still running (decision 12).`);
    }

    if (!groupColoursSettled) {
      failures.push('Could not read the settled group header\'s colours/text.');
    } else {
      if (groupColoursSettled.labelColor !== errorColor) failures.push(`Settled failed group: header label measured ${groupColoursSettled.labelColor}, expected the error colour ${errorColor} (decision 12: the header turns red once settled as failed).`);
      else findings.push(`Settled failed group: header label/icon paint in the error colour (${groupColoursSettled.labelColor}), matching decision 12.`);
      if (!groupColoursSettled.metaFailedText || !groupColoursSettled.metaFailedText.includes('1 failed')) failures.push(`Settled group meta slot text is "${groupColoursSettled.metaFailedText}", expected to contain "1 failed" (decision 12).`);
      else findings.push(`Settled group meta slot reads "${groupColoursSettled.metaFailedText}" (decision 12, moved out of the summary text).`);
      if (groupColoursSettled.labelText && /\d+ failed/.test(groupColoursSettled.labelText)) failures.push(`Group summary text "${groupColoursSettled.labelText}" still contains "N failed" -- decision 12 moves this into the meta slot, out of the summary.`);
      else findings.push('Group summary text no longer contains the "N failed" suffix (moved to meta, decision 12).');
      if (!groupColoursSettled.detailText) failures.push('Settled failed group header: no Error line (aria-describedby target) found while collapsed -- decision 9 requires the latest failed member\'s line.');
      else {
        findings.push(`Settled group header Error line (collapsed): "${groupColoursSettled.detailText}".`);
        // The failing call is a silent `exit 9`: the line must show the exit-code fallback, not OMP's
        // "(no output)" placeholder or a bare "Failed.".
        if (groupColoursSettled.detailText === '(no output)') failures.push('Settled group header Error line still reads OMP\'s own "(no output)" placeholder -- the gate round 1 exit-code fallback fix did not take effect.');
        else if (groupColoursSettled.detailText === 'Failed.') failures.push('Settled group header Error line reads the generic "Failed." fallback -- the call\'s own exit code (9) was known and should have been shown instead.');
        else if (!/exited with code 9/i.test(groupColoursSettled.detailText)) failures.push(`Settled group header Error line reads "${groupColoursSettled.detailText}", expected it to contain "exited with code 9" (the exit 9 call's own exit status, gate round 1 fix).`);
        else findings.push('Settled group header Error line correctly shows the exit-code fallback ("exited with code 9"), not OMP\'s "(no output)" placeholder (gate round 1 fix confirmed live).');
        if (groupColoursSettled.detailColor !== errorColor) failures.push(`Group header Error line measured ${groupColoursSettled.detailColor}, expected the error colour ${errorColor}.`);
        else findings.push('Group header Error line paints in the error colour.');
        if (groupColoursSettled.ariaDescribedby !== groupColoursSettled.detailId) failures.push('Header aria-describedby does not resolve to the rendered Error line\'s own id.');
        else findings.push('Header trigger\'s aria-describedby correctly names the Error line\'s id (decision 15).');
      }
    }
    // Read the real accessible name from the AX tree to confirm the meta separator reads as distinct words.
    const groupHeaderAx = await getAccessibleNameAndRole(cdp, `(${BASH_HEADER_FINDER})[0]`);
    if (groupHeaderAx.name && /\d failed\d/.test(groupHeaderAx.name.replace(/\s+/g, ''))) {
      failures.push(`Group header accessible name "${groupHeaderAx.name}" still joins two counts with no separating word boundary.`);
    } else if (groupHeaderAx.name) {
      findings.push(`Group header accessible name (measured via Accessibility.getPartialAXTree): "${groupHeaderAx.name}".`);
    } else {
      notExercised.push('Could not read the group header\'s accessible name via the AX tree.');
    }
    // A separator sibling node once produced a doubled space before the comma in the accname.
    if (groupHeaderAx.name && groupHeaderAx.name.includes(' , ')) {
      failures.push(`Group header accessible name "${groupHeaderAx.name}" still has a doubled space before the comma separator (gate round 2 fix did not take effect).`);
    } else if (groupHeaderAx.name) {
      findings.push('Group header accessible name has no doubled space before the comma separator (gate round 2 fix confirmed).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-collapsed-failed-group.png'));

    // Mark the header's Error line <p> first, to prove later it stays the same mounted node (only
    // `hidden` toggles), so it is not re-announced on collapse.
    const detailMarker = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER})[0];
      const id = header ? header.getAttribute('aria-describedby') : null;
      const detail = id ? document.getElementById(id) : null;
      if (!detail) return null;
      const marker = 'verify570-' + Math.random().toString(36).slice(2);
      detail.setAttribute('data-verify-marker', marker);
      return marker;
    })()`);
    await setBashHeaderExpanded(cdp, 0, true);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-expanded-failed-group.png'));
    const expandedCheck = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER})[0];
      const stillDescribed = header ? header.getAttribute('aria-describedby') : 'MISSING-HEADER';
      const ol = document.querySelector('[aria-label="Transcript"] ol.border-l');
      const members = ol ? Array.from(ol.querySelectorAll('li')) : [];
      // M2 drops every (bash) member's own label; the error colour moved onto its summary span.
      const memberInfo = members.map((li) => {
        const label = li.querySelector('[data-slot="collapsed-line-label"]');
        const summary = li.querySelector('span.min-w-0.flex-1');
        const btn = li.querySelector('button');
        const describedby = btn ? btn.getAttribute('aria-describedby') : null;
        const detail = describedby ? document.getElementById(describedby) : null;
        return {
          labelColor: label ? getComputedStyle(label).color : null,
          summaryColor: summary ? getComputedStyle(summary).color : null,
          hasDetail: !!detail,
          detailText: detail ? detail.textContent.trim() : null
        };
      });
      const markedNode = document.querySelector('[data-verify-marker]');
      return { stillDescribed, memberCount: members.length, memberInfo, markerStillMounted: !!markedNode, markerHidden: markedNode ? markedNode.hasAttribute('hidden') : null };
    })()`);
    if (detailMarker && !expandedCheck.markerStillMounted) {
      failures.push('Gate round 2 (N6): the group header\'s Error line <p> was REMOVED from the DOM on expand (should stay mounted, only hidden) -- the re-announce-on-collapse fix did not take effect.');
    } else if (detailMarker && !expandedCheck.markerHidden) {
      failures.push('Gate round 2 (N6): the group header\'s Error line <p> stayed mounted on expand but is not `hidden` -- decision 9 requires it invisible while expanded.');
    } else if (detailMarker) {
      findings.push('Gate round 2 (N6): the group header\'s Error line <p> stays mounted (same node, marked) and is `hidden` while expanded, never unmounted.');
    } else {
      notExercised.push('Could not mark the group header\'s Error line <p> before expanding (N6 persistence check skipped).');
    }
    if (expandedCheck.stillDescribed) failures.push(`Group header still has aria-describedby="${expandedCheck.stillDescribed}" once EXPANDED -- decision 9 requires the header's own Error line (and its description) to disappear once expanded.`);
    else findings.push('Group header\'s own Error line/aria-describedby is gone once expanded (decision 9, hideDetailWhenOpen).');
    if (expandedCheck.memberCount !== 3) failures.push(`Expected 3 members in the expanded group, found ${expandedCheck.memberCount}.`);
    else findings.push('Expanded group shows all 3 members.');
    const isErrorColoured = (m) => m.labelColor === errorColor || m.summaryColor === errorColor;
    const failedMembers = expandedCheck.memberInfo.filter(isErrorColoured);
    if (failedMembers.length !== 1) failures.push(`Expected exactly 1 member with an error-coloured label/summary, found ${failedMembers.length} (${JSON.stringify(expandedCheck.memberInfo)}).`);
    else if (!failedMembers[0].hasDetail) failures.push('The one failed member has no Error line of its own once expanded (decision 9).');
    else findings.push(`The one failed member shows its own Error line once expanded: "${failedMembers[0].detailText}".`);
    const okMembers = expandedCheck.memberInfo.filter((m) => !isErrorColoured(m));
    if (okMembers.some((m) => m.hasDetail)) failures.push('A successful member row shows an Error line -- only a failed member should.');
    else findings.push('Successful member rows show no Error line.');
    await setBashHeaderExpanded(cdp, 0, false);
    if (detailMarker) {
      const recollapsedCheck = await cdp.evaluate(`(() => {
        const marked = document.querySelector('[data-verify-marker="${detailMarker}"]');
        return { found: !!marked, hidden: marked ? marked.hasAttribute('hidden') : null };
      })()`);
      if (!recollapsedCheck.found) failures.push('Gate round 2 (N6): the SAME marked Error line <p> is gone after re-collapsing -- it was unmounted and a fresh node took its place (the exact re-announce bug, since a fresh node is a new role="log" addition).');
      else if (recollapsedCheck.hidden) failures.push('Gate round 2 (N6): the Error line <p> is still `hidden` after re-collapsing -- decision 9 requires it visible again while collapsed.');
      else findings.push('Gate round 2 (N6): the SAME marked Error line <p> (not a fresh node) reappears, visible, after re-collapsing -- the re-announce-on-collapse fix holds across a full expand/collapse cycle.');
    }

    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_B_SENTINEL}/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished (assistant echoed the sentinel back)' },
    );
    const headerCountAfterB = await countBashHeaders(cdp);
    const soloIndex = headerCountAfterB - 1;
    const soloCollapsed = await readHeaderColours(cdp, soloIndex);
    const soloColoured = soloCollapsed && (soloCollapsed.labelColor === errorColor || soloCollapsed.summaryColor === errorColor); // M2: label dropped for bash, colour moves to summary
    if (!soloColoured) failures.push(`Solo failed call: header label/summary measured label=${soloCollapsed?.labelColor} summary=${soloCollapsed?.summaryColor}, expected ${errorColor} (decision 4).`);
    else findings.push(`Solo failed call: header icon/summary paint in the error colour (${soloCollapsed.summaryColor}), decision 4 (label dropped by M2 for this command-style row).`);
    const FOOTER_LEAK_PATTERN = /^(?:Wall time: |\(no output\)$)/;
    if (!soloCollapsed?.detailText) failures.push('Solo failed call: no Error line found while collapsed (decision 6).');
    else if (FOOTER_LEAK_PATTERN.test(soloCollapsed.detailText)) failures.push(`Solo failed call Error line reads "${soloCollapsed.detailText}" -- OMP's own wrapper footer/placeholder leaked through (decision 7).`);
    // Real stderr vs OMP's exit-code fallback depends on this machine's OMP line order, not a regression (#650).
    else findings.push(`Solo failed call Error line (collapsed) reads: "${soloCollapsed.detailText}" -- ${soloCollapsed.detailText.includes('cannot access') ? 'the real stderr line' : "OMP's own exit-code fallback, not the real stderr line (errorLine()/OMP line-order gap, #650)"}.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-dark-solo-failed-collapsed.png'));

    await setBashHeaderExpanded(cdp, soloIndex, true);
    const soloExpandedCheck = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER}).at(${soloIndex});
      const root = header ? header.closest('[data-slot="collapsible"]') : null;
      const content = root ? root.querySelector('[data-slot="collapsible-content"]') : null;
      const stillDescribed = header ? header.getAttribute('aria-describedby') : null;
      const detailStillPresent = stillDescribed ? !!document.getElementById(stillDescribed) : false;
      const duplicateErrorInContent = content ? Array.from(content.querySelectorAll('p')).some((p) => p.className.includes('severity-error')) : false;
      return { detailStillPresent, duplicateErrorInContent, contentText: content ? content.textContent.trim().slice(0, 200) : null };
    })()`);
    if (!soloExpandedCheck.detailStillPresent) failures.push('Solo failed call: Error line disappeared once EXPANDED -- decision 6 requires it visible whether collapsed or expanded (no hideDetailWhenOpen for a solo call).');
    else findings.push('Solo failed call: Error line stays visible once expanded (decision 6).');
    if (soloExpandedCheck.duplicateErrorInContent) failures.push('Solo failed call: the expanded body still contains its own error-coloured <p> -- decision 10 requires the old boxed error paragraph deleted (no duplicate).');
    else findings.push('Solo failed call: the expanded body no longer duplicates the error text (decision 10, old ToolCallBody <p> removed).');
    await cdp.screenshot(path.join(SHOTS_DIR, '04-dark-solo-failed-expanded.png'));
    await setBashHeaderExpanded(cdp, soloIndex, false);

    await setBashHeaderExpanded(cdp, 0, true);
    let themeChecksOk = true;
    try {
      await switchTheme(cdp, 'obsidian', 'Obsidian');
      await cdp.screenshot(path.join(SHOTS_DIR, '06-obsidian-expanded.png'));
      findings.push('Obsidian theme screenshot captured (real <html> class confirmed via the Profile menu Theme submenu).');

      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await cdp.screenshot(path.join(SHOTS_DIR, '07-dark-high-contrast-expanded.png'));
      findings.push('Dark (high contrast) theme screenshot captured (real <html> class confirmed).');
    } catch (err) {
      themeChecksOk = false;
      failures.push(`Could not drive the real Profile-menu Theme submenu (${err.message}).`);
    }

    // The group is still expanded, so its failed member carries the Error line (the header's is hidden while open).
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) failures.push('A horizontal scrollbar appeared at 360px width.');
    else findings.push('No horizontal scroll at 360px width (decision 18).');
    const narrowDetailCheck = await cdp.evaluate(`(() => {
      const ol = document.querySelector('[aria-label="Transcript"] ol.border-l');
      const members = ol ? Array.from(ol.querySelectorAll('li')) : [];
      const failedMember = members.find((li) => { const btn = li.querySelector('button'); const id = btn ? btn.getAttribute('aria-describedby') : null; return id && document.getElementById(id); });
      const btn = failedMember ? failedMember.querySelector('button') : null;
      const detail = btn ? document.getElementById(btn.getAttribute('aria-describedby')) : null;
      return {
        found: !!detail,
        lineClamp: detail ? getComputedStyle(detail).webkitLineClamp || getComputedStyle(detail).getPropertyValue('-webkit-line-clamp') : null,
        overflowing: detail ? detail.scrollHeight > detail.clientHeight + 2 : null,
      };
    })()`);
    if (!narrowDetailCheck.found) failures.push('At 360px, the expanded group\'s failed member has no Error line (decision 6/9).');
    else if (narrowDetailCheck.lineClamp !== '2') failures.push(`At 360px, the Error line's computed line-clamp is "${narrowDetailCheck.lineClamp}", expected "2" (decision 8).`);
    else findings.push('At 360px, the expanded group\'s failed member Error line is present and clamped to 2 lines (decisions 6, 8, 9).');
    await cdp.screenshot(path.join(SHOTS_DIR, '08-360px-expanded.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    try {
      // Escape first: the Theme submenu can leave the profile dropdown open, so later clicks hit its overlay.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      await sleep(300);
      await switchTheme(cdp, 'dark', 'Dark');
    } catch (err) {
      notExercised.push(`Could not confirm reset to Dark theme before reduced-motion check (${err.message}).`);
    }

    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const labelTransition = await cdp.evaluate(`(() => {
        const header = (${BASH_HEADER_FINDER})[0];
        const label = header ? header.querySelector('[data-slot="collapsed-line-label"]') : null;
        return label ? getComputedStyle(label).transitionProperty : null;
      })()`);
      if (labelTransition && labelTransition !== 'none' && labelTransition.includes('color')) failures.push(`Failed-row label computed transitionProperty includes "color" (${labelTransition}) -- decision 13 requires an instant colour change, no transition.`);
      else findings.push(`Failed-row label has no colour transition (${labelTransition ?? 'label not found'}), decision 13.`);
      await cdp.screenshot(path.join(SHOTS_DIR, '09-dark-reduced-motion.png'));
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    } catch (err) {
      notExercised.push(`Reduced-motion check could not complete (${err.message}).`);
    }
    try {
      await setBashHeaderExpanded(cdp, 0, false);
    } catch (err) {
      notExercised.push(`Could not collapse the group back down before turn (c) (${err.message}) -- harmless, turn (c) does not depend on this group's own open state.`);
    }

    // Diagnostic only, run last: a graceful Stop does not yield 'interrupted' (that needs a died
    // process), and stopping can leave the Session recovering, which must not block earlier assertions.
    try {
      await cdp.typeIntoByLabel('Message', TURN_C_PROMPT);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(`(${BASH_HEADER_FINDER}).length > ${headerCountAfterB}`, { timeoutMs: 20_000, label: 'Turn (c) bash header appears' });
      await sleep(500);
      await cdp.clickByLabel('Stop');
      await sleep(3000);
      const stoppedRowInfo = await cdp.evaluate(`(() => {
        const h = (${BASH_HEADER_FINDER}).at(-1);
        if (!h) return null;
        const label = h.querySelector('[data-slot="collapsed-line-label"]');
        const summary = h.querySelector('span.min-w-0.flex-1');
        const srWord = h.querySelector('span.sr-only');
        const describedby = h.getAttribute('aria-describedby');
        const detail = describedby ? document.getElementById(describedby) : null;
        return {
          labelColor: label ? getComputedStyle(label).color : null,
          summaryColor: summary ? getComputedStyle(summary).color : null,
          srStatusWord: srWord ? srWord.textContent.trim() : null,
          hasErrorLine: !!detail,
          detailText: detail ? detail.textContent.trim() : null,
        };
      })()`);
      await cdp.screenshot(path.join(SHOTS_DIR, '05-dark-after-stop-mid-flight.png'));
      if (!stoppedRowInfo) {
        notExercised.push('Turn (c): no bash header found after Stop -- could not observe the post-Stop state at all.');
      } else {
        findings.push(`Turn (c), 3s after clicking Stop mid-flight (M3, diagnostic only, no specific value asserted): status word "${stoppedRowInfo.srStatusWord}", label colour ${stoppedRowInfo.labelColor}, summary colour ${stoppedRowInfo.summaryColor}, Error line ${stoppedRowInfo.hasErrorLine ? `present ("${stoppedRowInfo.detailText}")` : 'absent'}.`);
        const stoppedColoured = stoppedRowInfo.labelColor === errorColor || stoppedRowInfo.summaryColor === errorColor;
        if (stoppedColoured) {
          // Informational: the 'interrupted'/'exited' branches are pre-existing (#510/#490), not a #570 regression.
          findings.push(`Turn (c), M3 CONFIRMED (not merely [INFERENCE]): a user-initiated Stop produced the FULL error-colour treatment (label ${stoppedRowInfo.labelColor}, summary ${stoppedRowInfo.summaryColor}, status word "${stoppedRowInfo.srStatusWord}") -- decision 5's reasoning ("nothing is known to have gone wrong") argues this should stay neutral. PRE-EXISTING #510 behaviour, unmodified by #570; a gap for #510/#490 to resolve, not scored as a #570 failure.`);
        } else {
          findings.push(`Turn (c): a user-initiated Stop did NOT produce the error colour (label stayed ${stoppedRowInfo.labelColor}, summary ${stoppedRowInfo.summaryColor}) -- M3's [INFERENCE] does not reproduce in this run.`);
        }
      }
    } catch (err) {
      notExercised.push(`Turn (c) diagnostic (M3) could not complete (${err.message}).`);
    }const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      neutralColor,
      errorColor,
      findings,
      failures,
      notExercised,
      themeChecksOk,
      exitCode: failures.length > 0 ? 1 : 0,
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-570: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-570: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-570: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-570: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-570: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-570: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
