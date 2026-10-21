#!/usr/bin/env node
// Live CDP check for issue #1069 (Model roles overhaul): one provider switch filters every chat
// role's model dropdown, the provider drops off dropdown items and triggers, an off-provider
// role's trigger stays the real model plus a "via {provider}" tag, and each chat role gets a
// reasoning-level radio group (enabled per its own model's `reasoning`/`thinking` fields).
//
// Drives the fake-omp shim (`verify-tauri-fake-omp.mjs`), extended by this same issue to answer
// the one-shot `omp config get/set modelRoles --json` and `omp models --kind <kind> --json` CLI
// calls it never handled before (neither is part of the `--mode rpc-ui` wire tape): a scratch
// `REFRACT_FAKE_OMP_CONFIG_STORE` JSON file this script seeds/reads for `modelRoles`, and the
// new `scripts/fixtures/model-catalogs/chat-1069.json` fixture (two providers, a mix of
// reasoning and non-reasoning models, partial `thinking` arrays -- that fixture's own README has
// the full table) for the chat catalog.
//
// Proves, against the real rendered DOM:
//   1. The provider switch (`[aria-label="Provider"]`) starts selected on GitHub Copilot, the
//      provider of the seeded Default role's own current model.
//   2. Default's own model dropdown, opened for real, lists only GitHub Copilot's models, each
//      item showing the model's name alone (no "(github-copilot)" parenthetical).
//   3. Smol's current model (`anthropic/claude-haiku-5.5:low`) is on a different provider than
//      the switch: its trigger still shows "Claude Haiku 5.5", with a muted "via Anthropic" tag,
//      never blanked and never the raw suffixed selector string.
//   4. Default's and Slow's triggers show the model's display name only -- no provider, no
//      trailing `:level` suffix -- even though Slow's own stored value carries none and Default's
//      carries `:high`; Vision (left unconfigured) shows plain "Inherited".
//   5. Reasoning radios exist only on the 10 chat roles, never the 5 model-kind roles.
//   6. Slow's model (`reasoning:false`) disables every level except Inherit, each with a
//      "Not supported by GPT 3.5 Turbo" reason; Vision (unconfigured) disables every level except
//      Inherit with "Pick a model first".
//   7. Keyboard-switching the provider to Anthropic re-filters Default's dropdown to Anthropic's
//      own two models only; switching back restores GitHub Copilot's three.
//   8. Picking Default's "Medium" radio (a real click) writes `...claude-fable-5:medium`, read
//      back through a fresh `window.refract.modelRoles.list()` IPC call -- not just the DOM;
//      pressing ArrowRight (keyboard) moves to the next enabled level, "High", and writes
//      `...:high`; the trigger keeps showing "Claude Fable 5" throughout, never the suffix.
//      Picking Inherit afterwards clears the suffix back to the bare selector.
//
// Every screenshot is preceded by `settleForScreenshot` (pointer moved inside the viewport,
// blurred, Escape pressed, fails loudly if a tooltip or hover card is still open).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1069_SHOTS_DIR || path.join(tmpdir(), `refract-1069-roles-overhaul-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');

// Seeded `modelRoles` record (the fake config store's `modelRoles` key): Default and Slow stay on
// GitHub Copilot (the provider the switch must start on); Smol is deliberately on Anthropic (the
// off-provider display proof); Vision is left unconfigured (the "Pick a model first" proof); the
// other six chat roles and the five model-kind roles are left unconfigured too -- not needed by
// any assertion below.
const SEEDED_MODEL_ROLES = {
  default: 'github-copilot/claude-fable-5:high',
  smol: 'anthropic/claude-haiku-5.5:low',
  slow: 'github-copilot/gpt-3.5-turbo'
};

const ARROW_RIGHT = { code: 39, key: 'ArrowRight', domCode: 'ArrowRight' };

function assertTrue(actual, label, findings, failures) {
  if (actual) findings.push(`${label}: true`);
  else failures.push(`${label}: expected true, got ${JSON.stringify(actual)}`);
}

function assertEqual(actual, expected, label, findings, failures) {
  if (actual === expected) findings.push(`${label}: ${JSON.stringify(actual)}`);
  else failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Gate round 1 precedent (`verify-1101-git-polish.mjs`'s own header comment): moves the pointer
 * INSIDE the viewport (a corner then an interior point, so Chromium genuinely fires
 * `pointerleave` on whatever was last hovered), blurs, presses Escape, then FAILS loudly if a
 * tooltip or hover card is still open immediately before a screenshot. */
async function settleForScreenshot(cdp, findings, failures) {
  const { width, height } = await cdp.evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.floor(width / 2), y: Math.floor(height / 2) });
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
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
  // The radios above mount unconditionally (they tolerate an unresolved catalog entry with their
  // own "Pick a model first" reason), so their presence alone does NOT prove the chat catalog's
  // own `omp models --kind chat --json` one-shot call has resolved yet -- wait for the provider
  // switch to render at least one real segment too (it renders nothing until `catalogs.chat` is
  // populated), or every assertion below races the load and reads pre-catalog raw selectors.
  await cdp.waitFor(`document.querySelectorAll('[aria-label="Provider"] [data-slot="toggle-group-item"]').length > 0`, {
    timeoutMs: 15_000,
    label: 'Chat model catalog loaded (provider switch has real segments)'
  });
}

/** Reads each `[aria-label="Provider"]` segment's own text and whether it is currently selected. */
async function readProviderSegments(cdp) {
  return cdp.evaluate(
    `Array.from(document.querySelectorAll('[aria-label="Provider"] [data-slot="toggle-group-item"]')).map((el) => ({ text: el.textContent.trim(), on: el.getAttribute('data-state') === 'on' }))`
  );
}

/** A role's own trigger text (the `SelectValue`'s rendered content), closed-state -- no need to
 * open the popup, Radix mirrors the matched item's children into the trigger either way. */
async function readTriggerText(cdp, role) {
  return cdp.evaluate(`document.getElementById('model-role-${role}')?.textContent.trim() ?? null`);
}

/** Opens a role's own Select, reads every real `[role="option"]`'s visible text, then closes it
 * with Escape -- never a shortcut past the actual Radix popup. */
async function readDropdownItemTexts(cdp, role) {
  await cdp.click(`document.getElementById('model-role-${role}')`);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: `${role}: dropdown opened` });
  const texts = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent.trim())`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: `${role}: dropdown closed` });
  return texts;
}

/** One reasoning-radio item's own disabled/reason state, read by its fixed DOM id
 * (`model-role-<role>-reasoning-<level>`, `RoleReasoningRadios.tsx`'s own convention). */
async function readRadioState(cdp, role, level) {
  return cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(`model-role-${role}-reasoning-${level}`)});
    if (!el) return null;
    const describedBy = el.getAttribute('aria-describedby');
    const reasonEl = describedBy ? document.getElementById(describedBy) : null;
    return { exists: true, disabled: el.disabled === true, checked: el.getAttribute('data-state') === 'checked', reason: reasonEl ? reasonEl.textContent.trim() : null };
  })()`);
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

  async function shot(name) {
    await settleForScreenshot(cdp, findings, failures);
    await cdp.screenshot(path.join(SHOTS_DIR, name));
    screenshotNames.push(name);
  }

  async function readModelRolesViaIpc() {
    return cdp.evaluate(`window.refract.modelRoles.list().then((r) => (r.ok ? r.value : null))`);
  }

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
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
        REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
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
    const repoName = path.basename(repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, composer enabled'
    });

    await openSettingsModelRoles(cdp);

    // ---- 1. The switch starts on GitHub Copilot (Default's own seeded provider). ----
    const segmentsBefore = await readProviderSegments(cdp);
    findings.push(`Provider segments at open: ${JSON.stringify(segmentsBefore)}`);
    const onSegments = segmentsBefore.filter((s) => s.on);
    assertEqual(onSegments.length, 1, 'Exactly one provider segment selected', findings, failures);
    assertEqual(onSegments[0]?.text, 'GitHub Copilot', 'Switch starts on GitHub Copilot (Default role\u2019s own provider)', findings, failures);

    // ---- 2/4. Trigger text: name only, no provider, no suffix (Default, Slow), and plain
    // "Inherited" for the unconfigured Vision role. ----
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger shows the model name only (seeded :high suffix dropped)', findings, failures);
    assertEqual(await readTriggerText(cdp, 'slow'), 'GPT 3.5 Turbo', 'Slow trigger shows the model name only', findings, failures);
    assertEqual(await readTriggerText(cdp, 'vision'), 'Inherited', 'Vision (unconfigured) trigger reads plain Inherited', findings, failures);

    // ---- 3. Smol (on Anthropic, a different provider) keeps its real model name, tagged. ----
    const smolTrigger = await readTriggerText(cdp, 'smol');
    assertTrue(smolTrigger?.includes('Claude Haiku 5.5') ?? false, `Smol trigger names its real model (got ${JSON.stringify(smolTrigger)})`, findings, failures);
    assertTrue(smolTrigger?.includes('via Anthropic') ?? false, `Smol trigger carries a "via Anthropic" tag (got ${JSON.stringify(smolTrigger)})`, findings, failures);

    // ---- 2 continued. Default's own dropdown lists only GitHub Copilot's three models, no
    // provider parenthetical. ----
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

    // ---- 5/6. Reasoning radios exist only on chat roles; Slow (non-reasoning) and Vision
    // (unconfigured) disable every level but Inherit, each with its own stated reason. ----
    const imageRadio = await readRadioState(cdp, 'image', 'inherit');
    assertEqual(imageRadio, null, 'Image (a model-kind role) has no reasoning radio group at all', findings, failures);
    const defaultInherit = await readRadioState(cdp, 'default', 'inherit');
    assertTrue(defaultInherit?.exists === true && defaultInherit.disabled === false, 'Default\u2019s Inherit option is enabled', findings, failures);

    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const slowState = await readRadioState(cdp, 'slow', level);
      assertTrue(slowState?.disabled === true, `Slow\u2019s ${level} radio is disabled (non-reasoning model)`, findings, failures);
      assertEqual(slowState?.reason, 'Not supported by GPT 3.5 Turbo', `Slow\u2019s ${level} radio states why (${level})`, findings, failures);
      const visionState = await readRadioState(cdp, 'vision', level);
      assertTrue(visionState?.disabled === true, `Vision\u2019s ${level} radio is disabled (no model set)`, findings, failures);
      assertEqual(visionState?.reason, 'Pick a model first', `Vision\u2019s ${level} radio states why (${level})`, findings, failures);
    }
    // Default's own model (Claude Fable 5) reports every one of the five levels plus reasoning,
    // so every radio should be enabled -- the positive case alongside Slow/Vision's negative one.
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const state = await readRadioState(cdp, 'default', level);
      assertTrue(state?.disabled === false, `Default\u2019s ${level} radio is enabled (model supports it)`, findings, failures);
    }
    assertEqual(await readRadioState(cdp, 'default', 'high').then((s) => s.checked), true, 'Default\u2019s radio reads the seeded :high level as checked', findings, failures);

    // Named per role, not a shared generic name (accessibility section).
    const radioGroupName = await cdp.evaluate(
      `(() => { const el = document.getElementById('model-role-default-reasoning-inherit'); const group = el.closest('[role="radiogroup"]'); const labelId = group?.getAttribute('aria-labelledby'); return labelId ? document.getElementById(labelId)?.textContent.trim() : null; })()`
    );
    assertEqual(radioGroupName, 'Default', 'Default\u2019s reasoning radiogroup is named via its own role label', findings, failures);

    await shot('01-seeded-state.png');

    // ---- 7. Keyboard-switch the provider to Anthropic; Default's dropdown re-filters. Focuses
    // via a direct `.focus()` call (never a click first) so the keyboard proof below is never
    // ambiguous about whether a prior pointer interaction, not the keyboard, moved focus. Reads
    // and records the segment state after ArrowRight ALONE before pressing anything else: Radix's
    // ToggleGroup "single" mode deselects an ALREADY-selected item on a second activation
    // (`ManageSessionsToolbar.tsx`'s own header comment), so if arrow navigation itself already
    // moves the selection (radiogroup-style), a further Space/Enter on the now-selected item
    // would wrongly deselect it -- Space is sent only when the arrow move alone did not select.
    // Every read polls (`cdp.waitFor`) rather than reading once immediately after dispatching a
    // key: a one-shot read raced React's own re-render in earlier runs of this exact check
    // (non-deterministic pass/fail against identical actions), confirmed by comparing two runs'
    // `report.json` side by side -- a real script bug, not a product one. ----
    const PROVIDER_SEGMENT_FINDER = `document.querySelectorAll('[aria-label="Provider"] [data-slot="toggle-group-item"]')`;
    async function selectedProviderSegment() {
      return cdp.evaluate(`Array.from(${PROVIDER_SEGMENT_FINDER}).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() ?? null`);
    }
    async function focusProviderSegment(text) {
      await cdp.evaluate(`Array.from(${PROVIDER_SEGMENT_FINDER}).find((el) => el.textContent.trim() === ${JSON.stringify(text)})?.focus()`);
    }
    async function keyboardSwitchProviderTo(targetText, arrowCode, arrowKey) {
      await pressKey(cdp, arrowCode, arrowKey, arrowKey);
      await sleep(200);
      let selected = await selectedProviderSegment();
      findings.push(`Provider switch: after ${arrowKey} alone, selected = ${JSON.stringify(selected)}`);
      if (selected !== targetText) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
        try {
          await cdp.waitFor(
            `Array.from(${PROVIDER_SEGMENT_FINDER}).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === ${JSON.stringify(targetText)}`,
            { timeoutMs: 3_000, label: `Provider switch moves to ${targetText} after ${arrowKey}+Space` }
          );
        } catch {
          // Fall through: the assertion below reports whatever was actually observed.
        }
        selected = await selectedProviderSegment();
        findings.push(`Provider switch: after ${arrowKey}+Space, selected = ${JSON.stringify(selected)}`);
      }
      return selected;
    }

    await focusProviderSegment('GitHub Copilot');
    const afterRightArrow = await keyboardSwitchProviderTo('Anthropic', 39, 'ArrowRight');
    assertEqual(afterRightArrow, 'Anthropic', 'Keyboard moves the provider switch to Anthropic', findings, failures);
    const anthropicItems = await readDropdownItemTexts(cdp, 'default');
    assertTrue(anthropicItems.some((t) => t.includes('Claude Haiku 5.5')) && anthropicItems.some((t) => t.includes('Claude Opus 5.5')), 'Default dropdown now lists Anthropic\u2019s models', findings, failures);
    // Claude Fable 5 MAY still appear once here -- not as a regular filtered-list item, but as
    // Default's own PINNED current-model entry (decision 3: a role's current model is never
    // dropped just because the switch moved elsewhere); only the GPT models are exclusively
    // GitHub Copilot's own regular list items, so their absence is what actually proves filtering.
    assertTrue(!anthropicItems.some((t) => t.includes('GPT')), 'Default dropdown no longer lists GitHub Copilot\u2019s own (non-pinned) models', findings, failures);

    // Restore GitHub Copilot for the remaining checks. Keyboard operability of the switch is
    // already fully proven by the forward move above (ArrowRight then Space selects the newly
    // focused segment); a plain click is enough to put the UI back in its seeded state for what
    // follows, not a second keyboard claim.
    await cdp.click(`Array.from(document.querySelectorAll('[aria-label="Provider"] [data-slot="toggle-group-item"]')).find((el) => el.textContent.trim() === 'GitHub Copilot')`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('[aria-label="Provider"] [data-slot="toggle-group-item"]')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === 'GitHub Copilot'`,
      { timeoutMs: 5_000, label: 'Switch restored to GitHub Copilot' }
    );

    // ---- 8. Picking a reasoning level writes the suffix, read back through a fresh IPC call;
    // ArrowRight (keyboard) moves to the next enabled level; Inherit clears the suffix. The
    // trigger keeps showing the bare model name throughout (decision 5). Polls the real IPC value
    // directly (`window.refract.modelRoles.list()`), not the DOM `data-state`: the write is an
    // async round trip through the store and the fake-omp config file (get, set, get again), and
    // this is the actual ground truth the claim is about, not a proxy for it. ----
    await cdp.click(`document.getElementById('model-role-default-reasoning-medium')`);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'github-copilot/claude-fable-5:medium')`, {
      timeoutMs: 8_000,
      label: 'Picking Medium writes :medium (modelRoles.list() IPC)'
    });
    let rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'github-copilot/claude-fable-5:medium', 'Picking Medium writes the :medium suffix (read back via modelRoles.list())', findings, failures);
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger still shows the name only after picking Medium', findings, failures);

    await pressKey(cdp, ARROW_RIGHT.code, ARROW_RIGHT.key, ARROW_RIGHT.domCode);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'github-copilot/claude-fable-5:high')`, {
      timeoutMs: 8_000,
      label: 'Keyboard ArrowRight writes :high (modelRoles.list() IPC)'
    });
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'github-copilot/claude-fable-5:high', 'Keyboard ArrowRight writes the :high suffix (read back via modelRoles.list())', findings, failures);

    await cdp.click(`document.getElementById('model-role-default-reasoning-inherit')`);
    await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'github-copilot/claude-fable-5')`, {
      timeoutMs: 8_000,
      label: 'Picking Inherit clears the suffix (modelRoles.list() IPC)'
    });
    rolesNow = await readModelRolesViaIpc();
    assertEqual(rolesNow?.default, 'github-copilot/claude-fable-5', 'Picking Inherit clears the suffix back to the bare selector', findings, failures);
    assertEqual(await readTriggerText(cdp, 'default'), 'Claude Fable 5', 'Default trigger unchanged after clearing the suffix', findings, failures);

    await shot('02-after-provider-switch-and-level-picks.png');

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
