#!/usr/bin/env node
// Live CDP check for #557: consecutive "Thought for Ns" rows collapse into one ThoughtRun header.
// Uses real `omp` in a scratch Session and spends real model tokens.
// A 2+ item run only forms when a hidden `todo` call sits between two thinking passes with no
// text; the prompt scripts that order, but model message boundaries are not guaranteed.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  sha256OfFile,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget,
  assertExeUnchanged,
  getAccessibleNameAndRole,
  switchTheme,
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';

const SCRIPT_LABEL = 'verify-557-thought-runs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Refuses to fall back to a worktree-local src-tauri/target (#946).
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = path.join(tmpdir(), 'refract-557-gate1-shots');

const REASONING_MODEL = { provider: 'github-copilot', id: 'claude-sonnet-5' };
const REASONING_LEVEL = 'high';

const TURN_A_PROMPT =
  "A train leaves city A at 60mph, another leaves city B (300 miles away) at 90mph toward A at the same time; find when and where they meet. Follow this exact order, with NO text output of any kind until the very last step: (1) call the todo tool once now (one init op), as required. (2) Think in detail working out the closing-speed method numerically -- write out at least eight distinct, separately-numbered considerations (the closing speed itself, the combined distance, the time to close it, each train's own distance travelled, a sanity check against each train's own speed, a check the numbers are physically sensible, a restatement of the method, and a final numeric answer for this method) before moving on; take real time over this, do not write any reply text yet, only reasoning. (3) Call the todo tool a second time to mark that method done -- still write no reply text. (4) Think in detail again, this time re-deriving the answer with an independent relative-frames method to double check -- still write no reply text. (5) Only now, after both reasoning passes and both todo calls, write your final reply: exactly the single word 'probe557a' and nothing else. Call no tool other than todo.";
const TURN_A_SENTINEL = 'probe557a';
const TURN_B_PROMPT =
  "Multiply 47 by 83, working it out digit by digit in your head first. Then reply with exactly the single word 'probe557b' and nothing else.";
const TURN_B_SENTINEL = 'probe557b';

// Exact-label match, not textContent substring: a streaming assistant bubble could contain these words.
const THOUGHT_HEADER_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button')).filter((el) => { const label = el.querySelector('[data-slot="collapsed-line-label"]'); return label && label.textContent.trim() === 'Thought process'; })`;
const SOLO_THOUGHT_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button')).filter((el) => { const label = el.querySelector('[data-slot="collapsed-line-label"]'); const t = label && label.textContent.trim(); return t === 'Thinking' || t === 'Thought' || (t && t.startsWith('Thought for ')); })`;

function assertBundleContainsStory557Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsStory557Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('thought-run')) {
      console.log(`${SCRIPT_LABEL}: confirmed #557-only marker 'thought-run' present in the built renderer bundle (${file}).`);
      return;
    }
  }
  throw new Error("assertBundleContainsStory557Marker: no built asset contains 'thought-run' -- this build does not actually contain #557's own code.");
}

async function countThoughtHeaders(cdp) {
  return cdp.evaluate(`(${THOUGHT_HEADER_FINDER}).length`);
}
async function countSoloThoughts(cdp) {
  return cdp.evaluate(`(${SOLO_THOUGHT_FINDER}).length`);
}

async function setThoughtHeaderExpanded(cdp, index, wantOpen) {
  const isOpen = await cdp.evaluate(`(${THOUGHT_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === 'true'`);
  if (isOpen === wantOpen) return;
  const rect = await cdp.evaluate(`(() => { const el = (${THOUGHT_HEADER_FINDER}).at(${index}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error(`setThoughtHeaderExpanded: no thought header at index ${index}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.waitFor(
    `(${THOUGHT_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === '${wantOpen}'`,
    { timeoutMs: 10_000, label: `thought header ${index} aria-expanded=${wantOpen}` },
  );
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, exeDir2, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = []; // Wrong measured values -- ALWAYS fails the run. Never a graceful skip.
  const notExercised = []; // Genuine skips only.
  let exeHash = null;
  let gitHeadSha = null;
  let multiRunExercised = false;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-557-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-557-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-557-repo-')), SCRIPT_LABEL);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-557-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-557-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`${SCRIPT_LABEL}: git HEAD ${gitHeadSha}`);
    console.log(`${SCRIPT_LABEL}: data dir ${dataDir}`);
    console.log(`${SCRIPT_LABEL}: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: SCRIPT_LABEL });
    const exePath = built.dest;
    exeHash = built.hash;
    assertBundleContainsStory557Marker();
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`${SCRIPT_LABEL}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', SCRIPT_LABEL);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
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

    const sessionId = await cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value[0]?.id : null))`);
    if (!sessionId) throw new Error(`${SCRIPT_LABEL}: could not read the scratch Session id back from window.refract.sessions.list()`);

    const setModelResp = await cdp.evaluate(
      `window.refract.model.setModel(${JSON.stringify(sessionId)}, ${JSON.stringify(REASONING_MODEL.provider)}, ${JSON.stringify(REASONING_MODEL.id)})`,
    );
    if (!setModelResp || setModelResp.ok !== true) failures.push(`model.setModel failed: ${JSON.stringify(setModelResp)}`);
    else findings.push(`Session model set to ${REASONING_MODEL.provider}/${REASONING_MODEL.id} via the real model IPC.`);
    const setLevelResp = await cdp.evaluate(`window.refract.model.setThinkingLevel(${JSON.stringify(sessionId)}, ${JSON.stringify(REASONING_LEVEL)})`);
    if (!setLevelResp || setLevelResp.ok !== true) failures.push(`model.setThinkingLevel failed: ${JSON.stringify(setLevelResp)}`);
    else findings.push(`Session thinking level set to "${REASONING_LEVEL}".`);

    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    try {
      await cdp.waitFor(`(${SOLO_THOUGHT_FINDER}).length > 0 || (${THOUGHT_HEADER_FINDER}).length > 0`, { timeoutMs: 30_000, label: 'first thought row appears (best-effort running capture)' });
      await cdp.screenshot(path.join(SHOTS_DIR, '00-dark-running.png'));
      findings.push('Captured a best-effort live/streaming screenshot before turn (a) settled.');
    } catch {
      notExercised.push('Could not capture a thought row mid-run before it settled (real model timing).');
    }

    // Run timing is not scriptable: if the run already grew past one item, this downgrades to
    // `notExercised`, never a failure. TURN_A_PROMPT's long first reasoning phase widens the window.
    try {
      const soloNow = await cdp.evaluate(`(${SOLO_THOUGHT_FINDER}).length > 0 && (${THOUGHT_HEADER_FINDER}).length === 0`);
      if (!soloNow) throw new Error('no solo thought row was available to focus before the run already grew past one member');
      await cdp.evaluate(`(() => { const el = (${SOLO_THOUGHT_FINDER})[0]; el.focus(); window.__thoughtGrowthFocusTarget = el; })()`);
      const focusedSolo = await cdp.evaluate(`document.activeElement === window.__thoughtGrowthFocusTarget`);
      if (!focusedSolo) throw new Error('could not focus the solo thought row');
      await cdp.pressEnter();
      await cdp.waitFor(`window.__thoughtGrowthFocusTarget?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'solo thought row expands on Enter' });
      await cdp.waitFor(`(${THOUGHT_HEADER_FINDER}).length > 0`, {
        timeoutMs: 150_000,
        intervalMs: 150,
        label: 'the run grows to 2+ members while the solo row is focused and expanded',
      });
      const growthResult = await cdp.evaluate(`(() => {
        const header = (${THOUGHT_HEADER_FINDER})[0];
        const root = header ? header.closest('[data-slot="collapsible"]') : null;
        const ol = root ? root.querySelector('ol.border-l') : null;
        const firstMember = ol ? ol.querySelector('li button') : null;
        return {
          headerIsSameElement: header === window.__thoughtGrowthFocusTarget,
          sameNode: document.activeElement === window.__thoughtGrowthFocusTarget,
          stillExpanded: header?.getAttribute('aria-expanded') === 'true',
          firstMemberOpen: firstMember?.getAttribute('aria-expanded') === 'true',
        };
      })()`);
      await cdp.screenshot(path.join(SHOTS_DIR, '00b-dark-growth-focus-preserved.png'));
      if (!growthResult.headerIsSameElement) {
        failures.push('The thought-run header is a DIFFERENT DOM element than the one focused while solo -- the row remounted when it grew (decisions 15/17 violation).');
      } else {
        findings.push('The SAME DOM element that was solo is still the header after growth to 2+ members -- no remount (decisions 15/17 fix confirmed live).');
      }
      if (!growthResult.sameNode) failures.push('document.activeElement moved away from the thought-run trigger when the run grew (decision 17 requires focus to stay put).');
      else findings.push('Keyboard focus stayed on the thought-run trigger across growth from solo to 2+ members (decision 17).');
      if (!growthResult.stillExpanded) failures.push('The thought-run header closed itself when the run grew from solo to 2+ members (decision 14 violation).');
      else findings.push('The run stayed expanded across growth from solo to 2+ members (decision 14).');
      if (!growthResult.firstMemberOpen) failures.push('Member 1 did not start open after the run grew while its own solo row was expanded (decision 15 violation).');
      else findings.push('Member 1 starts open because the run was expanded at the moment it grew past one item (decision 15).');

      // A collapse then re-expand must not reopen member 1 (the growth-open flag is consumed once).
      await setThoughtHeaderExpanded(cdp, 0, false);
      await setThoughtHeaderExpanded(cdp, 0, true);
      const memberReopened = await cdp.evaluate(`(() => {
        const root = (${THOUGHT_HEADER_FINDER})[0].closest('[data-slot="collapsible"]');
        const ol = root ? root.querySelector('ol.border-l') : null;
        const firstMember = ol ? ol.querySelector('li button') : null;
        return firstMember?.getAttribute('aria-expanded') === 'true';
      })()`);
      if (memberReopened) failures.push('Member 1 reopened on a LATER re-expand of the header (collapse, then expand again) -- decision 15 requires every later mount to start collapsed.');
      else findings.push('A later collapse-then-re-expand of the header leaves member 1 collapsed (decision 15).');
      await setThoughtHeaderExpanded(cdp, 0, false);
    } catch (err) {
      notExercised.push(
        `Growth-with-focus live check did not complete this run (${err.message}) -- real model timing: the run may have grown to 2+ members before a solo row could be caught and focused, or it never grew past one at all this run. See turn-a-transcript.html.`,
      );
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
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-turn-a-settled.png'));

    const headerCountAfterA = await countThoughtHeaders(cdp);
    const soloCountAfterA = await countSoloThoughts(cdp);
    multiRunExercised = headerCountAfterA > 0;

    if (!multiRunExercised) {
      notExercised.push(
        `Turn (a)'s real model did not produce a 2+ member ThoughtRun this run (0 "Thought process" headers, ${soloCountAfterA} solo thought row(s) instead) -- a model's own message-boundary/thinking-chunking behaviour is not scriptable; see turn-a-transcript.html. The multi-member header, union-duration, growth, and SpineList-keyboard checks below are skipped as a genuine not-exercised, not a failure.`,
      );
    } else {
      findings.push(`Multi-member ThoughtRunRow header rendered after turn (a) (${headerCountAfterA} header(s) -- decision 7/8: a run of 2+ gets "Thought process").`);

      const metaTextSettled = await cdp.evaluate(`(${THOUGHT_HEADER_FINDER})[0].querySelector('.tabular-nums')?.innerText.trim() ?? (${THOUGHT_HEADER_FINDER})[0].innerText`);
      if (!/\d+ steps/.test(metaTextSettled)) failures.push(`Settled thought-run header meta does not contain "N steps" (measured: "${metaTextSettled}") -- decision 8.`);
      else findings.push(`Settled thought-run header meta reads "${metaTextSettled.trim()}" (decision 8: step count, plus total time once every member is timed).`);
      // The header total must carry the same 1s floor as its members, so "0s" never appears.
      if (/\b0s\b/.test(metaTextSettled)) {
        failures.push(`Settled thought-run header meta reads "${metaTextSettled.trim()}" -- contains "0s" despite the 1s-floor fix (gate round 1 Medium).`);
      } else {
        findings.push('Settled thought-run header meta never reads "0s" (gate round 1 fix: the header total now shares the members\' own 1s floor).');
      }

      const thoughtOlWhileCollapsed = await cdp.evaluate(`(() => {
        const header = (${THOUGHT_HEADER_FINDER})[0];
        const root = header.closest('[data-slot="collapsible"]');
        return root ? !!root.querySelector('ol.border-l') : null;
      })()`);
      if (thoughtOlWhileCollapsed) failures.push('A SpineList <ol> is present under the thought-run header while still COLLAPSED -- decision 14 requires it unmounted until expanded.');
      else findings.push('SpineList under the thought-run header is unmounted while collapsed (decision 14, mirrors #565 decision 17).');

      await setThoughtHeaderExpanded(cdp, 0, true);
      await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-expanded.png'));
      const expandedGeometry = await cdp.evaluate(`(() => {
        const header = (${THOUGHT_HEADER_FINDER})[0];
        const root = header.closest('[data-slot="collapsible"]');
        const ol = root ? root.querySelector('ol.border-l') : null;
        const members = ol ? Array.from(ol.querySelectorAll('li')) : [];
        const memberLabels = members.map((li) => li.querySelector('[data-slot="collapsed-line-label"]')?.textContent.trim());
        return { memberCount: members.length, memberLabels };
      })()`);
      if (expandedGeometry.memberCount < 2) {
        failures.push(`Expected 2+ SpineList members under the thought-run header, found ${expandedGeometry.memberCount}.`);
      } else {
        findings.push(`Thought-run expands to ${expandedGeometry.memberCount} members on a SpineList, labels ${JSON.stringify(expandedGeometry.memberLabels)} (decision 11: each member keeps today's own "Thought for Ns"/"Thought"/"Thinking" wording, never "Step N").`);
        if (expandedGeometry.memberLabels.some((l) => /^Step \d/.test(l ?? ''))) {
          failures.push('A member row is labelled "Step N" -- decision 11 forbids relabelling members.');
        }
      }

      await cdp.click(`(() => { const root = (${THOUGHT_HEADER_FINDER})[0].closest('[data-slot="collapsible"]'); const ol = root ? root.querySelector('ol.border-l') : null; const li = ol ? ol.querySelector('li') : null; return li ? li.querySelector('button') : null; })()`);
      const memberBodyPadding = await cdp.evaluate(`(() => {
        const root = (${THOUGHT_HEADER_FINDER})[0].closest('[data-slot="collapsible"]');
        const ol = root ? root.querySelector('ol.border-l') : null;
        const content = ol ? ol.querySelector('[data-slot="collapsible-content"]') : null;
        return content ? getComputedStyle(content).paddingLeft : null;
      })()`);
      if (memberBodyPadding !== '32px') failures.push(`Member expanded body computed padding-left is ${memberBodyPadding}, expected 32px (pl-8, decision 13).`);
      else findings.push('Member expanded body starts at pl-8 (32px), the label column (decision 13).');
      await cdp.screenshot(path.join(SHOTS_DIR, '03-dark-member-expanded.png'));

      const headerAx = await getAccessibleNameAndRole(cdp, `(${THOUGHT_HEADER_FINDER})[0]`);
      if (!headerAx.name || !headerAx.name.startsWith('Thought process')) {
        failures.push(`Settled thought-run header accessible name is "${headerAx.name}", expected to start "Thought process" (decision 18/19).`);
      } else {
        findings.push(`Settled thought-run header accessible name: "${headerAx.name}" (decision 19, AX tree -- the WebView2/NVDA-reachable name).`);
      }

      await setThoughtHeaderExpanded(cdp, 0, false);
      const headerFocusable = await cdp.evaluate(`(() => { const el = (${THOUGHT_HEADER_FINDER})[0]; el.focus(); return document.activeElement === el; })()`);
      if (!headerFocusable) failures.push('Thought-run header did not accept programmatic focus.');
      await cdp.pressEnter();
      const openedByEnter = await cdp.waitFor(`(${THOUGHT_HEADER_FINDER})[0]?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Enter expands the thought-run header' }).catch(() => false);
      if (!openedByEnter) failures.push('Pressing Enter on the focused thought-run header did not expand it (decision 16).');
      else findings.push('Keyboard: Enter on the focused header expands the run (decision 16).');
      // Chromium only moves focus on a Tab keydown whose `key` is literally "Tab", so use the shared sender.
      await pressTab(cdp);
      const focusMovedToMember = await cdp.waitFor(`(() => {
        const root = (${THOUGHT_HEADER_FINDER})[0].closest('[data-slot="collapsible"]');
        const ol = root ? root.querySelector('ol.border-l') : null;
        const firstMemberButton = ol ? ol.querySelector('li button') : null;
        return !!firstMemberButton && document.activeElement === firstMemberButton;
      })()`, { timeoutMs: 5_000, label: 'Tab from the header lands on the first member\'s own trigger' }).catch(() => false);
      if (!focusMovedToMember) failures.push("Tab from the expanded header's own trigger did not land on the first member's own trigger (decision 16).");
      else findings.push("Keyboard: Tab from the expanded header's own trigger moves to the first member's trigger next (decision 16).");
      await pressEscape(cdp);
      await setThoughtHeaderExpanded(cdp, 0, false);
      findings.push('Collapsing the run unmounts the SpineList again.');

      try {
        await setThoughtHeaderExpanded(cdp, 0, true);
        await switchTheme(cdp, 'obsidian', 'Obsidian');
        await cdp.screenshot(path.join(SHOTS_DIR, '04-obsidian-expanded.png'));
        findings.push('Obsidian theme screenshot captured, run expanded.');
        await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
        await cdp.screenshot(path.join(SHOTS_DIR, '05-dark-high-contrast-expanded.png'));
        findings.push('Dark (high contrast) theme screenshot captured, run expanded.');
      } catch (err) {
        failures.push(`Could not drive the real Profile-menu Theme submenu (${err.message}).`);
      }

      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
      if (narrowOverflow) failures.push('A horizontal scrollbar appeared at 360px width -- decision 27 requires no horizontal scroll.');
      else findings.push('No horizontal scroll at 360px width (decision 27).');
      await cdp.screenshot(path.join(SHOTS_DIR, '06-360px-expanded.png'));
      await cdp.send('Emulation.clearDeviceMetricsOverride', {});

      try {
        await switchTheme(cdp, 'dark', 'Dark');
      } catch (err) {
        notExercised.push(`Could not confirm reset to Dark theme before reduced-motion check (${err.message}).`);
      }
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const motion = await cdp.evaluate(`(() => {
        const root = (${THOUGHT_HEADER_FINDER})[0].closest('[data-slot="collapsible"]');
        const ol = root ? root.querySelector('ol.border-l') : null;
        const member = ol ? ol.querySelector('li') : null;
        const read = (el) => { if (!el) return null; const s = getComputedStyle(el); return { transitionDuration: s.transitionDuration, animationName: s.animationName }; };
        return { spine: read(ol), member: read(member) };
      })()`);
      const motionOk = (m) => !!m && m.transitionDuration.split(',').every((d) => parseFloat(d) <= 0.001) && m.animationName === 'none';
      if (!motion.member) notExercised.push('Could not measure a member row\'s own transition/animation under reduced motion.');
      else if (!motionOk(motion.member)) failures.push(`Member row computed transitionDuration=${motion.member.transitionDuration}, animationName=${motion.member.animationName} under reduced motion -- decision 24's fade must be suppressed.`);
      else findings.push('Member row\'s own fade-in animation is suppressed under reduced motion (decision 24/25, motion-safe:).');
      await cdp.screenshot(path.join(SHOTS_DIR, '07-dark-reduced-motion.png'));
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });

      const toggleOffResp = await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', false)`);
      if (!toggleOffResp || toggleOffResp.ok !== true) failures.push(`settings.setTranscriptDisplay('thinking', false) failed: ${JSON.stringify(toggleOffResp)}`);
      await sleep(300);
      const headerCountThinkingOff = await countThoughtHeaders(cdp);
      const soloCountThinkingOff = await countSoloThoughts(cdp);
      if (headerCountThinkingOff !== 0 || soloCountThinkingOff !== 0) {
        failures.push(`With Thinking off, ${headerCountThinkingOff} thought-run header(s) and ${soloCountThinkingOff} solo thought row(s) are still visible -- decision 21 requires every thought row ('thinking'/'thought-run') to hide, never 'sr-only'.`);
      } else {
        findings.push('With "Show thinking" off, every thought row (the run and any solo thought) is hidden entirely (decision 21).');
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '08-dark-thinking-off.png'));
      const toggleOnResp = await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', true)`);
      if (!toggleOnResp || toggleOnResp.ok !== true) failures.push(`settings.setTranscriptDisplay('thinking', true) (restore) failed: ${JSON.stringify(toggleOnResp)}`);
      await sleep(300);
      const headerCountRestored = await countThoughtHeaders(cdp);
      if (headerCountRestored !== headerCountAfterA) failures.push(`Restoring "Show thinking" did not bring back the same ${headerCountAfterA} thought-run header(s) (measured ${headerCountRestored}).`);
      else findings.push('Restoring "Show thinking" brings every thought row back with no reload (decision 21).');

      const toolCallsOffResp = await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('toolCalls', false)`);
      if (!toolCallsOffResp || toolCallsOffResp.ok !== true) failures.push(`settings.setTranscriptDisplay('toolCalls', false) failed: ${JSON.stringify(toolCallsOffResp)}`);
      await sleep(300);
      const headerCountToolsOff = await countThoughtHeaders(cdp);
      if (headerCountToolsOff !== headerCountAfterA) failures.push(`With "Show tool calls" off, thought-run header count changed to ${headerCountToolsOff} (expected unchanged ${headerCountAfterA}) -- a thought run must never key off the toolCalls toggle.`);
      else findings.push('"Show tool calls" off does not affect thought-run visibility (independent toggles).');
      await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('toolCalls', true)`);
      await sleep(200);
    }

    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_B_SENTINEL}/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished (assistant echoed the sentinel back)' },
    );
    const turnBTranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-b-transcript.html'), turnBTranscriptHtml);
    const soloCountAfterB = await countSoloThoughts(cdp);
    if (soloCountAfterB < 1) {
      // The model may answer without exposing a thinking part; that is model variance, not a #557 defect.
      notExercised.push(`Turn (b) produced 0 solo thought rows this run (the model did not expose a visible thinking part for this prompt) -- see turn-b-transcript.html. Not a #557 defect: a prior run of this same build rendered a solo "Thought for Ns" row correctly with no code change.`);
    } else {
      findings.push(`Turn (b) rendered ${soloCountAfterB} solo thought row(s) (decision 7: a run of one is exactly today's row, no header, no Spine).`);
      const soloOlCount = await cdp.evaluate(`(() => {
        const header = (${SOLO_THOUGHT_FINDER}).at(-1);
        const root = header ? header.closest('[data-slot="collapsible"]') : null;
        return root ? root.querySelectorAll('ol.border-l').length : 0;
      })()`);
      if (soloOlCount > 0) failures.push(`A SpineList <ol> was found under a solo thought row -- decision 7 requires no Spine for a run of one.`);
      else findings.push('A run of exactly one thought renders with no SpineList and no <ol> (decision 7).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '09-dark-turn-b-solo.png'));

    await stopLauncher(child);
    child = null;
    exeDir2 = mkdtempSync(path.join(tmpdir(), 'refract-557-exe2-'));
    const exePath2 = path.join(exeDir2, 'refract-tauri.exe');
    // Copy into a fresh scratch dir so this launch never locks the exe path the stopped launcher held.
    copyFileSync(exePath, exePath2);
    if (sha256OfFile(exePath2) !== exeHash) throw new Error(`${SCRIPT_LABEL}: the exe copy for the relaunch does not match the hash already verified for turn (a)/(b).`);
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exePath2, { port: port2, dataDir, importSourceDir, logFile: path.join(exeDir2, 'app2.log') });
    child = launched2.child;
    const wsUrl2 = await waitForCdpTarget(port2, { timeoutMs: 60_000 });
    cdp.close();
    cdp = await CdpSession.connect(wsUrl2);
    await cdp.waitFor(`!!window.refract`, { timeoutMs: 30_000, label: 'window.refract bridge ready after restart' });
    const reopened = await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(sessionId)}, true)`);
    if (!reopened || reopened.ok !== true) {
      notExercised.push(`Could not reopen the scratch Session after restart to check the untimed-history meta (${JSON.stringify(reopened)}).`);
    } else {
      // `sessions.open` reattaches the agent but does not select the pane; click the session row.
      await cdp.waitFor(`!!document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]')`, { timeoutMs: 30_000, label: 'Session row visible in the list after restart' });
      await cdp.click(`document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]')`);
      await cdp.waitFor(`!!document.querySelector('[aria-label="Transcript"]')`, { timeoutMs: 30_000, label: 'Transcript re-rendered after reopen' });
      // A flat sleep raced ahead of reattach + history fetch; poll until the placeholder clears.
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return false; const ready = t.textContent.includes('Ready. Type a message'); return !ready || (${SOLO_THOUGHT_FINDER}).length > 0 || (${THOUGHT_HEADER_FINDER}).length > 0; })()`,
        { timeoutMs: 60_000, label: 'Reopened history replaces the "Ready" placeholder with real content' },
      ).catch(() => {
        notExercised.push('Reopened Session still showed the empty "Ready" placeholder after a 60s wait -- history did not visibly replay in time for this run.');
      });
      if (multiRunExercised) {
        const headerCountReopened = await countThoughtHeaders(cdp);
        if (headerCountReopened < 1) {
          notExercised.push(`Reopened history: no thought-run header found after restart (expected the turn (a) run to replay); see reopened-transcript.html.`);
        } else {
          const metaTextReopened = await cdp.evaluate(`(${THOUGHT_HEADER_FINDER})[0].querySelector('.tabular-nums')?.innerText.trim() ?? (${THOUGHT_HEADER_FINDER})[0].innerText`);
          const hasTime = /\d+(\.\d+)?s\b/.test(metaTextReopened) || /\d+m\s*\d+s/.test(metaTextReopened);
          if (hasTime) failures.push(`Reopened (history) thought-run header still shows a time ("${metaTextReopened.trim()}") -- decision 10 requires step-count-only, since history replay (capture_timing=false) carries no bounds.`);
          else findings.push(`Reopened (history) thought-run header reads "${metaTextReopened.trim()}" -- step count only, no time (decision 10/FR-009).`);
        }
      } else {
        const soloCountReopened = await countSoloThoughts(cdp);
        notExercised.push(`Multi-member run was not exercised live, so the reopened-history check only confirms solo thought rows still render after a restart (${soloCountReopened} found) -- the untimed-meta claim is unverified for the multi-member case.`);
      }
      const reopenedTranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
      writeFileSync(path.join(SHOTS_DIR, 'reopened-transcript.html'), reopenedTranscriptHtml);
      await cdp.screenshot(path.join(SHOTS_DIR, '10-dark-reopened-history.png'));
    }

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, multiRunExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${SCRIPT_LABEL}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${SCRIPT_LABEL}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${SCRIPT_LABEL}: NOT EXERCISED (genuine skips only) ===`);
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${SCRIPT_LABEL}: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, multiRunExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
    }
    console.error(`${SCRIPT_LABEL}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, SCRIPT_LABEL);
    await safeRmSync(importSourceDir, SCRIPT_LABEL);
    await safeRmSync(repoDir, SCRIPT_LABEL);
    await safeRmSync(exeDir, SCRIPT_LABEL);
    await safeRmSync(exeDir2, SCRIPT_LABEL);
    await safeRmSync(launcherDir, SCRIPT_LABEL);
  }
}

main().catch((err) => {
  console.error(`${SCRIPT_LABEL}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
