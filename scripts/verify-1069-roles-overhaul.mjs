#!/usr/bin/env node
// Live CDP check for #1069 (Model roles overhaul): provider switch filtering, "via {provider}" tags, and per-role reasoning radios, driven against the fake-omp shim.
// No Session is created: a live Session on the changed role makes each pick wait on `apply_role_change`'s propagation sweep (up to three 60s RPCs per Session).
// Every built-in theme is dark-toned, so Dark plus Obsidian stand in for "Dark and one light theme".

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, pressKey } from './verify-tauri-session-list-helpers.mjs';
import { PROVIDER_SWITCH_SELECTOR, keyboardSwitchProviderTo, readReasonCaption, countConfigSetCalls, readProviderSegments, readTriggerText, readDropdownItemTexts, readRadioState, runUnmountDropsHeldLevelCase, runFocusRecoveryOnUnsupportedTransitionCase, runKeptAutoRadioKeepsFocusCase } from './verify-1069-roles-overhaul-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1069_SHOTS_DIR || path.join(tmpdir(), `refract-1069-roles-overhaul-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');

// Smol is deliberately on Anthropic (off-provider display), Vision is unconfigured, and Plan carries a literal `:auto` suffix outside the seven-option UI vocabulary.
const SEEDED_MODEL_ROLES = {
  default: 'github-copilot/claude-fable-5:high',
  smol: 'anthropic/claude-haiku-5.5:low',
  slow: 'github-copilot/gpt-3.5-turbo',
  plan: 'github-copilot/gpt-5.6-terra:auto'
};

function assertTrue(actual, label, findings, failures) {
  if (actual) findings.push(`${label}: true`);
  else failures.push(`${label}: expected true, got ${JSON.stringify(actual)}`);
}

function assertEqual(actual, expected, label, findings, failures) {
  if (actual === expected) findings.push(`${label}: ${JSON.stringify(actual)}`);
  else failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Moves the pointer to a corner then the interior (so Chromium fires `pointerleave`), blurs, presses Escape, and fails if a tooltip or hover card is still open before a screenshot. */
async function settleForScreenshot(cdp, findings, failures, { keepFocus = false } = {}) {
  const { width, height } = await cdp.evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.floor(width / 2), y: Math.floor(height / 2) });
  if (!keepFocus) await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await sleep(100);
  const overlayOpen = await cdp.evaluate(`!!document.querySelector('[role="tooltip"], [data-slot="tooltip-content"], [data-slot="hover-card-content"]')`);
  if (overlayOpen) {
    findings.push('settleForScreenshot: an overlay was still present');
    failures.push('A tooltip or hover card was still open immediately before a screenshot');
  }
}

async function openSettingsModelRoles(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Model roles')`);
  await cdp.waitFor(`!!document.getElementById('model-role-default-reasoning-inherit')`, { timeoutMs: 15_000, label: 'Model roles section mounted (reasoning radios present)' });
  // The radios mount before the catalog resolves; the switch renders nothing until `catalogs.chat` loads, so wait on it or assertions race the load.
  await cdp.waitFor(`document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]').length > 0`, {
    timeoutMs: 15_000,
    label: 'Chat model catalog loaded (provider switch has real segments)'
  });
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir, configStorePath;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  const screenshotNames = [];

  const dirtyResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const dirtyLines = dirtyResult.status === 0 ? dirtyResult.stdout.split('\n').filter(Boolean) : null;
  const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length > 0;

  async function shot(name, options) {
    await settleForScreenshot(cdp, findings, failures, options);
    await cdp.screenshot(path.join(SHOTS_DIR, name));
    screenshotNames.push(name);
  }

  async function readModelRolesViaIpc() {
    return cdp.evaluate(`window.refract.modelRoles.list().then((r) => (r.ok ? r.value : null))`);
  }

  let debugLogPath;

  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1069-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1069-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1069-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1069-repo-')), 'verify-1069-roles-overhaul');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1069-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1069-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    gitHeadSha = gitHead(REPO_ROOT);
    console.log(`verify-1069: git HEAD ${gitHeadSha}${dirty ? ' (DIRTY)' : ''}`);
    console.log(`verify-1069: shots dir ${SHOTS_DIR}`);

    configStorePath = path.join(dataDir, 'fake-omp-config-store.json');
    writeFileSync(configStorePath, JSON.stringify({ modelRoles: SEEDED_MODEL_ROLES }));
    debugLogPath = path.join(SHOTS_DIR, 'fake-omp-invocations.log');

    const port = await getFreePort();
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1069' });
    const exePath = built.dest;
    exeHash = built.hash;

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
        REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
        // Keeps a Select model save in flight long enough to pick a radio against it; 600ms fits inside every 8s `waitFor`.
        REFRACT_FAKE_OMP_CONFIG_SET_DELAY_MS: '600',
        // Written to SHOTS_DIR, not exeDir, so a failed run's evidence survives `finally`.
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath
      }
    });
    child = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1069: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-1069');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await addRepository(cdp, repoDir);

    await openSettingsModelRoles(cdp);

    const switchLabelText = await cdp.evaluate(`document.getElementById('model-role-provider-switch-label')?.textContent.trim() ?? null`);
    assertEqual(switchLabelText, 'Show models from', 'Provider switch carries a visible "Show models from" label', findings, failures);
    const segmentsBefore = await readProviderSegments(cdp);
    findings.push(`Provider segments at open: ${JSON.stringify(segmentsBefore)}`);
    const onSegments = segmentsBefore.filter((s) => s.on);
    assertEqual(onSegments.length, 1, 'Exactly one provider segment selected', findings, failures);
    assertEqual(onSegments[0]?.text, 'GitHub Copilot', 'Switch starts on GitHub Copilot (Default role\u2019s own provider)', findings, failures);

    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger shows the model name only (seeded :high suffix dropped)', findings, failures);
    assertEqual(await readTriggerText(cdp, 'slow'), 'GPT 3.5 Turbo', 'Slow trigger shows the model name only', findings, failures);
    assertEqual(await readTriggerText(cdp, 'vision'), 'Inherited', 'Vision (unconfigured) trigger reads plain Inherited', findings, failures);

    const smolTrigger = await readTriggerText(cdp, 'smol');
    assertEqual(smolTrigger, 'Claude Haiku 5.5 via Anthropic', 'Smol trigger names its real model with a spaced "via Anthropic" tag', findings, failures);

    const defaultItems = await readDropdownItemTexts(cdp, 'default');
    findings.push(`Default dropdown items: ${JSON.stringify(defaultItems)}`);
    assertTrue(
      defaultItems.some((t) => t.includes('Claude Fable 5')) && defaultItems.some((t) => t.includes('GPT 5.6 Terra')) && defaultItems.some((t) => t.includes('GPT 3.5 Turbo')),
      'Default dropdown lists every GitHub Copilot model',
      findings,
      failures
    );
    assertTrue(!defaultItems.some((t) => t.includes('Claude Haiku') || t.includes('Claude Opus')), 'Default dropdown excludes Anthropic models (filtered by provider)', findings, failures);
    assertTrue(!defaultItems.some((t) => t.includes('(')), 'No dropdown item shows a provider parenthetical', findings, failures);
    assertEqual(new Set(defaultItems).size, defaultItems.length, 'Default dropdown items have no duplicate text', findings, failures);

    const imageRadio = await readRadioState(cdp, 'image', 'inherit');
    assertEqual(imageRadio, null, 'Image (a model-kind role) has no reasoning radio group at all', findings, failures);
    const defaultInherit = await readRadioState(cdp, 'default', 'inherit');
    assertTrue(defaultInherit?.exists === true && defaultInherit.disabled === false, 'Default\u2019s Inherit option is enabled', findings, failures);

    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const slowState = await readRadioState(cdp, 'slow', level);
      assertTrue(slowState?.disabled === true, `Slow\u2019s ${level} radio is disabled (non-reasoning model)`, findings, failures);
      const visionState = await readRadioState(cdp, 'vision', level);
      assertTrue(visionState?.disabled === true, `Vision\u2019s ${level} radio is disabled (no model set)`, findings, failures);
    }
    assertEqual(
      await readReasonCaption(cdp, 'slow'),
      "GPT 3.5 Turbo doesn't support reasoning",
      'Slow\u2019s visible caption names the model as a whole, not a six-level list (gate round 2, Medium #6)',
      findings,
      failures
    );
    assertEqual(await readReasonCaption(cdp, 'vision'), 'Pick a model first', 'Vision\u2019s visible caption (no model set)', findings, failures);
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const state = await readRadioState(cdp, 'default', level);
      assertTrue(state?.disabled === false, `Default\u2019s ${level} radio is enabled (model supports it)`, findings, failures);
    }
    assertEqual(await readRadioState(cdp, 'default', 'high').then((s) => s.checked), true, 'Default\u2019s radio reads the seeded :high level as checked', findings, failures);

    const planAuto = await readRadioState(cdp, 'plan', 'auto');
    assertTrue(planAuto?.exists === true && planAuto.checked === true && planAuto.disabled === false, 'Plan\u2019s own :auto suffix shows a checked, enabled "Auto" radio', findings, failures);

    const radioGroupName = await cdp.evaluate(
      `(() => { const el = document.getElementById('model-role-default-reasoning-inherit'); const group = el.closest('[role="radiogroup"]'); const labelId = group?.getAttribute('aria-labelledby'); return labelId ? labelId.split(' ').map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ') : null; })()`
    );
    assertEqual(radioGroupName, 'Default Reasoning', 'Default\u2019s reasoning radiogroup is named "{Role} Reasoning" via its own role label plus a sr-only sub-label', findings, failures);

    await shot('01-seeded-state.png');

    // Focus via `.focus()` (no click) so the keyboard proof is not confounded by a pointer interaction.
    const rolesBeforeSwitch = await readModelRolesViaIpc();
    await cdp.evaluate(`document.querySelector('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')?.focus()`);
    const afterRightArrow = await keyboardSwitchProviderTo(cdp, pressKey, findings, 'Anthropic', 39, 'ArrowRight');
    assertEqual(afterRightArrow, 'Anthropic', 'Keyboard moves the provider switch to Anthropic', findings, failures);
    const rolesAfterSwitch = await readModelRolesViaIpc();
    assertEqual(JSON.stringify(rolesAfterSwitch), JSON.stringify(rolesBeforeSwitch), 'modelRoles.list() is unchanged by the provider switch (a display filter, never a write)', findings, failures);

    const anthropicItems = await readDropdownItemTexts(cdp, 'default');
    assertTrue(anthropicItems.some((t) => t.includes('Claude Haiku 5.5')) && anthropicItems.some((t) => t.includes('Claude Opus 5.5')), 'Default dropdown now lists Anthropic\u2019s models', findings, failures);
    // Claude Fable 5 may still appear as Default's pinned current model, so only the GPT models' absence proves filtering.
    assertTrue(!anthropicItems.some((t) => t.includes('GPT')), 'Default dropdown no longer lists GitHub Copilot\u2019s own (non-pinned) models', findings, failures);

    const defaultTriggerOnAnthropic = await readTriggerText(cdp, 'default');
    assertEqual(defaultTriggerOnAnthropic, 'Claude Fable 5 via GitHub Copilot', 'Default\u2019s trigger shows "via GitHub Copilot" once Anthropic is selected', findings, failures);
    await shot('02-anthropic-via-github-copilot.png');

    await cdp.click(`Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.textContent.trim() === 'GitHub Copilot')`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === 'GitHub Copilot'`,
      { timeoutMs: 5_000, label: 'Switch restored to GitHub Copilot' }
    );

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'Obsidian theme applied' });
    await shot('03-obsidian-seeded-state.png');
    await cdp.evaluate(`window.refract.theme.set('dark')`);
    await cdp.waitFor(`document.documentElement.className.includes('theme-dark') && !document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'Dark theme restored' });

    // Poll the IPC value, not DOM `data-state`: the write is an async round trip and IPC is the ground truth.
    const configSetBeforeMedium = countConfigSetCalls(debugLogPath);
    await cdp.click(`document.getElementById('model-role-default-reasoning-medium')`);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'github-copilot/claude-fable-5:medium')`, {
      timeoutMs: 8_000,
      label: 'Picking Medium writes :medium (modelRoles.list() IPC)'
    });
    let rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'github-copilot/claude-fable-5:medium', 'Picking Medium writes the :medium suffix (read back via modelRoles.list())', findings, failures);
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger still shows the name only after picking Medium', findings, failures);
    assertTrue(countConfigSetCalls(debugLogPath) - configSetBeforeMedium >= 1, 'Picking Medium made at least one config-set call', findings, failures);

    // Three rapid ArrowRight presses wrap Medium -> Inherit; latest-pick-wins coalescing must cost at most two `config set` writes and keep focus on the radio.
    await cdp.click(`document.getElementById('model-role-default')`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: 'Default dropdown closed before Tab' });
    await pressKey(cdp, 9, 'Tab', 'Tab');
    await cdp.waitFor(`document.activeElement?.id === 'model-role-default-reasoning-medium'`, {
      timeoutMs: 5_000,
      label: 'Tab from the trigger reaches the checked Medium radio (never `.focus()`)'
    });
    // Hold each key down until `aria-checked` confirms: a zero-latency keyDown+keyUp races Radix's `isArrowKeyPressedRef`, so the keyup can clear it before the select lands.
    const configSetBeforeArrows = countConfigSetCalls(debugLogPath);
    const arrowSequence = [
      'model-role-default-reasoning-high',
      'model-role-default-reasoning-xhigh',
      'model-role-default-reasoning-inherit'
    ];
    for (let i = 0; i < 3; i += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
      await cdp.waitFor(`document.getElementById('${arrowSequence[i]}')?.getAttribute('aria-checked') === 'true'`, {
        timeoutMs: 2_000,
        label: `ArrowRight #${i + 1} selects ${arrowSequence[i]} (checked) while the key is still down`
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
    }
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'github-copilot/claude-fable-5')`, {
      timeoutMs: 8_000,
      label: 'Three rapid ArrowRight presses (Medium -> High -> Extra high -> wraps to Inherit) settle via IPC'
    });
    const focusedAfterArrows = await cdp.evaluate(`document.activeElement?.id ?? null`);
    assertEqual(focusedAfterArrows, 'model-role-default-reasoning-inherit', 'Focus stays on the picked radio (Inherit) after three rapid ArrowRight presses', findings, failures);
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'github-copilot/claude-fable-5', 'Three rapid ArrowRight presses settle on the bare selector, read back via modelRoles.list()', findings, failures);
    const configSetDuringArrows = countConfigSetCalls(debugLogPath) - configSetBeforeArrows;
    findings.push(`config-set calls during the 3-ArrowRight burst: ${configSetDuringArrows}`);
    assertTrue(configSetDuringArrows >= 1 && configSetDuringArrows <= 2, `At most 2 config-set writes landed for 3 rapid ArrowRight presses, latest-pick-wins coalesced (got ${configSetDuringArrows})`, findings, failures);
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger unchanged after the ArrowRight burst (never the suffix)', findings, failures);

    // A radio pick made while a Select model save is in flight must be refused outright: focus stays, the dot does not move, nothing is held.
    await cdp.click(`Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.textContent.trim() === 'Anthropic')`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === 'Anthropic'`,
      { timeoutMs: 5_000, label: 'Switch moved to Anthropic for the refuse-while-saving check' }
    );
    const defaultBusy = `document.getElementById('model-role-default-reasoning-inherit')?.closest('[role="radiogroup"]')?.getAttribute('aria-busy') === 'true'`;
    await cdp.click(`document.getElementById('model-role-default')`);
    await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: 'Default dropdown opened (refuse-while-saving check)' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.includes('Claude Opus 5.5'))`);
    await cdp.waitFor(defaultBusy, { timeoutMs: 2_000, label: 'Default radiogroup busy: the Claude Opus 5.5 model save is in flight' });
    await cdp.click(`document.getElementById('model-role-default-reasoning-high')`);
    await sleep(300); // let a (buggy) optimistic re-render land before reading, so "unchecked" is not vacuous
    const highCheckedWhileRefused = await cdp.evaluate(`document.getElementById('model-role-default-reasoning-high')?.getAttribute('aria-checked')`);
    assertEqual(highCheckedWhileRefused, 'false', 'A pick made during a Select model save is refused outright: the dot does not move', findings, failures);
    await shot('04-pending-save-in-row.png', { keepFocus: true }); // keepFocus: the assertion below proves the APP holds focus
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'anthropic/claude-opus-5.5')`, {
      timeoutMs: 8_000,
      label: 'The Claude Opus 5.5 model save lands bare -- the refused "High" pick never applied'
    });
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'anthropic/claude-opus-5.5', 'Gate round 3: a pick refused during a Select save never changes the stored value -- the model save alone lands, bare', findings, failures);
    const focusedAfterRefusedPick = await cdp.evaluate(`document.activeElement?.id ?? null`);
    assertEqual(focusedAfterRefusedPick, 'model-role-default-reasoning-high', 'Focus stays on the radio the user picked, even though the pick itself was refused', findings, failures);

    await cdp.click(`document.getElementById('model-role-default-reasoning-high')`);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'anthropic/claude-opus-5.5:high')`, {
      timeoutMs: 8_000,
      label: 'Picking High again after the model save lands writes normally'
    });
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'anthropic/claude-opus-5.5:high', 'Gate round 3: the SAME pick, retried once the save has landed, writes :high against the new model', findings, failures);
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Opus 5.5', 'Default trigger shows the new model\u2019s own name after the retried pick lands', findings, failures);
    // Unmount case runs FIRST (needs Medium/Low, Opus 5.5 supports both); focus-recovery below switches Default to Haiku 5.5 (supports neither), so it must run after.
    await runUnmountDropsHeldLevelCase(cdp, findings, failures, debugLogPath, defaultBusy, assertEqual, assertTrue);
    await runFocusRecoveryOnUnsupportedTransitionCase(cdp, findings, failures, debugLogPath, defaultBusy, assertEqual, assertTrue);

    // Restore GitHub Copilot: Plan's own real model (`:auto`) lives there.
    await cdp.click(`Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.textContent.trim() === 'GitHub Copilot')`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === 'GitHub Copilot'`,
      { timeoutMs: 5_000, label: 'Switch restored to GitHub Copilot before the Auto carry-over check' }
    );

    await cdp.click(`document.getElementById('model-role-plan')`);
    await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: 'Plan dropdown opened' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.includes('Claude Fable 5'))`);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.plan === 'github-copilot/claude-fable-5:auto')`, {
      timeoutMs: 8_000,
      label: 'Plan\u2019s own :auto suffix survives a model change (Claude Fable 5 also supports reasoning)'
    });
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.plan, 'github-copilot/claude-fable-5:auto', ':auto is carried over a model change, read back via modelRoles.list()', findings, failures);
    const planAutoAfterCarryOver = await readRadioState(cdp, 'plan', 'auto');
    assertTrue(planAutoAfterCarryOver?.checked === true, 'Plan\u2019s Auto radio is still checked after the model change carries :auto over', findings, failures);

    // Held-key dispatch as above. DOM order is Inherit, Off..Extra high, Auto, so ArrowRight from Auto wraps to Inherit and ArrowLeft wraps back.
    await cdp.click(`document.getElementById('model-role-plan')`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: 'Plan dropdown closed before Tab' });
    await pressKey(cdp, 9, 'Tab', 'Tab');
    await cdp.waitFor(`document.activeElement?.id === 'model-role-plan-reasoning-auto'`, { timeoutMs: 5_000, label: 'Tab from the Plan trigger reaches the checked Auto radio' });
    const configSetBeforeAutoArrows = countConfigSetCalls(debugLogPath);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
    await cdp.waitFor(`document.getElementById('model-role-plan-reasoning-inherit')?.getAttribute('aria-checked') === 'true'`, {
      timeoutMs: 2_000,
      label: 'ArrowRight off Auto wraps to Inherit (checked) while the key is still down'
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
    await cdp.waitFor(`document.getElementById('model-role-plan-reasoning-auto')?.getAttribute('aria-checked') === 'true'`, {
      timeoutMs: 2_000,
      label: 'ArrowLeft back to Auto wraps and selects it (checked) while the key is still down'
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
    const focusedAfterAutoArrowBack = await cdp.evaluate(`document.activeElement?.id ?? null`);
    assertEqual(focusedAfterAutoArrowBack, 'model-role-plan-reasoning-auto', 'Arrowing off Auto (ArrowRight) and back (ArrowLeft) keeps focus reachable on the Auto radio', findings, failures);
    const autoCheckedAfterArrowBack = await cdp.evaluate(`document.getElementById('model-role-plan-reasoning-auto')?.getAttribute('data-state') === 'checked'`);
    assertTrue(autoCheckedAfterArrowBack, 'Auto radio reads checked again immediately after arrowing off and back', findings, failures);
    // Wait for bare first, then `:auto`: Plan is already `:auto`, so a plain `:auto` wait could pass vacuously before either write landed.
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.plan === 'github-copilot/claude-fable-5')`, {
      timeoutMs: 8_000,
      label: 'Plan\u2019s own ArrowRight write (to bare/Inherit) lands first'
    });
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.plan === 'github-copilot/claude-fable-5:auto')`, {
      timeoutMs: 8_000,
      label: 'Plan settles back on :auto after the held ArrowLeft pick\u2019s flush lands'
    });
    const configSetDuringAutoArrows = countConfigSetCalls(debugLogPath) - configSetBeforeAutoArrows;
    assertTrue(configSetDuringAutoArrows >= 1, `At least one config-set call landed for the arrow-off-and-back (a real write happened, not a harness no-op; got ${configSetDuringAutoArrows})`, findings, failures);
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.plan, 'github-copilot/claude-fable-5:auto', 'Plan ends on :auto again after arrowing off and back, read via modelRoles.list()', findings, failures);

    await runKeptAutoRadioKeepsFocusCase(cdp, findings, failures, assertEqual, assertTrue); // #1127 finding 1
    // The failed-catalog case is not exercised: the fail env var is fixed for the fake-omp process lifetime.
    notExercised.push(
      'No caption while the chat catalog has failed to load (gate round 2, Medium #6): REFRACT_FAKE_OMP_MODEL_CATALOG_FAIL_KIND is fixed for the whole fake-omp process lifetime, so simulating it would break every other assertion in this same run that depends on the chat catalog loading successfully; a second, isolated app launch for this one claim was judged not worth the added build/run cost this round.'
    );

    await shot('05-after-provider-switch-and-level-picks.png');

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      screenshots: screenshotNames,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-1069: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1069: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1069: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1069: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-1069: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-1069: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
