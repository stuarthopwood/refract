// Shared helpers for `verify-1069-roles-overhaul.mjs`, split out to stay under the 600-line cap.
import { readFileSync } from 'node:fs';
import { sleep } from './verify-tauri-cdp.mjs';

/** The provider switch is targeted by its visible label's fixed id, not an `aria-label`. */
export const PROVIDER_SWITCH_SELECTOR = '[aria-labelledby="model-role-provider-switch-label"]';

/** Counts `omp config set` spawns in the fake-omp debug log: the ground truth for how many real
 * writes landed, proving coalescing costs at most one extra write. */
export function countConfigSetCalls(logPath) {
  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return 0;
  }
  return content.split('\n').filter((line) => line.includes('"config","set"')).length;
}

/** The single visible reason caption per role's reasoning radiogroup (not per item). */
export async function readReasonCaption(cdp, role) {
  return cdp.evaluate(`document.getElementById(${JSON.stringify(`model-role-${role}-label-reasoning-reason`)})?.textContent.trim() ?? null`);
}

/** Keyboard-switches the provider `ToggleGroup` to `targetText`; the caller must already have
 * focused the selected segment. Space is sent only if the arrow alone did not select, because
 * Radix single-mode deselects an already-selected item on a second activation. Reads poll
 * (`cdp.waitFor`) since a one-shot read raced React's re-render. */
export async function keyboardSwitchProviderTo(cdp, pressKey, findings, targetText, arrowCode, arrowKey) {
  const finder = `document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')`;
  async function selectedSegment() {
    return cdp.evaluate(`Array.from(${finder}).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() ?? null`);
  }
  await pressKey(cdp, arrowCode, arrowKey, arrowKey);
  await sleep(200);
  let selected = await selectedSegment();
  findings.push(`Provider switch: after ${arrowKey} alone, selected = ${JSON.stringify(selected)}`);
  if (selected !== targetText) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ', code: 'Space' });
    try {
      await cdp.waitFor(`Array.from(${finder}).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() === ${JSON.stringify(targetText)}`, {
        timeoutMs: 3_000,
        label: `Provider switch moves to ${targetText} after ${arrowKey}+Space`
      });
    } catch {
      // Fall through: the assertion below reports whatever was actually observed.
    }
    selected = await selectedSegment();
    findings.push(`Provider switch: after ${arrowKey}+Space, selected = ${JSON.stringify(selected)}`);
  }
  return selected;
}

/** Reads each provider segment's own text and whether it is currently selected. */
export async function readProviderSegments(cdp) {
  return cdp.evaluate(`Array.from(document.querySelectorAll('${PROVIDER_SWITCH_SELECTOR} [data-slot="toggle-group-item"]')).map((el) => ({ text: el.textContent.trim(), on: el.getAttribute('data-state') === 'on' }))`);
}

/** A role's trigger text; Radix mirrors the matched item into the trigger, so no popup needed. */
export async function readTriggerText(cdp, role) {
  return cdp.evaluate(`document.getElementById('model-role-${role}')?.textContent.trim() ?? null`);
}

/** Opens a role's Select through the real Radix popup, reads the options, closes with Escape. */
export async function readDropdownItemTexts(cdp, role) {
  await cdp.click(`document.getElementById('model-role-${role}')`);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: `${role}: dropdown opened` });
  const texts = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent.trim())`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: `${role}: dropdown closed` });
  return texts;
}

/** One reasoning-radio item's disabled/checked state, by id `model-role-<role>-reasoning-<level>`. */
export async function readRadioState(cdp, role, level) {
  return cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(`model-role-${role}-reasoning-${level}`)});
    if (!el) return null;
    return { exists: true, disabled: el.disabled === true, checked: el.getAttribute('data-state') === 'checked' };
  })()`);
}

/** A level held during a radio write must be dropped (no write) if the section unmounts mid-save.
 * `assertEqual`/`assertTrue` are passed in to avoid a circular import with the main script. */
export async function runUnmountDropsHeldLevelCase(cdp, findings, failures, debugLogPath, defaultBusyExpr, assertEqual, assertTrue) {
  const configSetBeforeMediumClick = countConfigSetCalls(debugLogPath);
  await cdp.click(`document.getElementById('model-role-default-reasoning-medium')`);
  await cdp.waitFor(defaultBusyExpr, { timeoutMs: 2_000, label: 'Default radiogroup busy: the radios\u2019 OWN Medium write is in flight (unmount case)' });
  await cdp.click(`document.getElementById('model-role-default-reasoning-low')`);
  await cdp.waitFor(`document.getElementById('model-role-default-reasoning-low')?.getAttribute('data-state') === 'checked'`, {
    timeoutMs: 2_000,
    label: 'The held Low pick registered (optimistic checked) before the section unmounts'
  });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!document.getElementById('model-role-default')`, { timeoutMs: 5_000, label: 'Model roles section unmounted (navigated to Appearance mid-save)' });
  await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'anthropic/claude-opus-5.5:medium')`, {
    timeoutMs: 8_000,
    label: 'The first (own) write -- Medium -- lands normally even after the section unmounts'
  });
  const rolesNow = await cdp.evaluate(`window.refract.modelRoles.list().then((r) => (r.ok ? r.value : null))`);
  assertEqual(rolesNow?.default, 'anthropic/claude-opus-5.5:medium', 'Gate round 3: unmount drops the HELD level (Low) -- only the first write (Medium) ever lands', findings, failures);
  await sleep(500); // give a (buggy) second write time to land before reading the log and counting
  const configSetLogAfterUnmount = readFileSync(debugLogPath, 'utf8');
  assertTrue(!configSetLogAfterUnmount.includes('claude-opus-5.5:low'), 'No stale-model write for the dropped held level (:low) appears in fake-omp-invocations.log', findings, failures);
  const configSetDuringUnmountCase = countConfigSetCalls(debugLogPath) - configSetBeforeMediumClick;
  assertEqual(configSetDuringUnmountCase, 1, 'Exactly one config-set call (Medium) landed; the held Low pick never fired a second write after the unmount', findings, failures);
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Model roles')`);
  await cdp.waitFor(`!!document.getElementById('model-role-default')`, { timeoutMs: 10_000, label: 'Back in Model roles section after the unmount case' });
}

/** A refused click still focuses its radio; if the new model then disables that level, focus must
 * move to the checked item (Inherit), never `<body>` (WCAG 2.4.3). */
export async function runFocusRecoveryOnUnsupportedTransitionCase(cdp, findings, failures, debugLogPath, defaultBusyExpr, assertEqual, assertTrue) {
  const configSetBeforeHaikuSwitch = countConfigSetCalls(debugLogPath);
  await cdp.click(`document.getElementById('model-role-default')`);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: 'Default dropdown opened (unsupported-transition focus check)' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.includes('Claude Haiku 5.5'))`);
  await cdp.waitFor(defaultBusyExpr, { timeoutMs: 2_000, label: 'Default radiogroup busy: the Claude Haiku 5.5 model save is in flight (unsupported-transition check)' });
  await cdp.click(`document.getElementById('model-role-default-reasoning-xhigh')`);
  await sleep(300); // let a (buggy) optimistic re-render land before reading, so "unchecked" is not vacuous
  const xhighCheckedWhileRefused = await cdp.evaluate(`document.getElementById('model-role-default-reasoning-xhigh')?.getAttribute('aria-checked')`);
  assertEqual(xhighCheckedWhileRefused, 'false', 'A pick made during the Haiku save is refused too: the dot does not move', findings, failures);
  await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.default === 'anthropic/claude-haiku-5.5')`, {
    timeoutMs: 8_000,
    label: 'The Claude Haiku 5.5 model save lands bare (High is not carryable) -- the refused Extra high pick never applied'
  });
  // The IPC read only proves the backend file landed; the re-render runs through a separate
  // `setRole()` chain, so wait for the DOM's disabled state before reading activeElement.
  await cdp.waitFor(`document.getElementById('model-role-default-reasoning-xhigh')?.disabled === true`, {
    timeoutMs: 8_000,
    label: 'Extra high reads natively disabled once the component re-renders with Claude Haiku 5.5'
  });
  const focusedAfterUnsupportedTransition = await cdp.evaluate(`document.activeElement?.id ?? null`);
  assertEqual(
    focusedAfterUnsupportedTransition,
    'model-role-default-reasoning-inherit',
    'Focus moves to the checked Inherit radio, never <body>, once the focused item (Extra high) goes natively disabled under the new model',
    findings,
    failures
  );
  const logAfterHaikuSwitch = readFileSync(debugLogPath, 'utf8');
  assertTrue(!logAfterHaikuSwitch.includes('claude-haiku-5.5:xhigh'), 'No :xhigh write for Claude Haiku 5.5 appears in fake-omp-invocations.log -- the refused pick never reached the backend', findings, failures);
  assertEqual(countConfigSetCalls(debugLogPath) - configSetBeforeHaikuSwitch, 1, 'Exactly one config-set call (the Haiku model switch) landed; the refused Extra high pick fired no write', findings, failures);
}

/** The focused Auto radio must not unmount, dropping focus to `<body>`, when a model save that
 * cannot carry `:auto` lands (WCAG 2.4.3). */
export async function runKeptAutoRadioKeepsFocusCase(cdp, findings, failures, assertEqual, assertTrue) {
  const planBusy = `document.getElementById('model-role-plan-reasoning-inherit')?.closest('[role="radiogroup"]')?.getAttribute('aria-busy') === 'true'`;
  await cdp.click(`document.getElementById('model-role-plan')`);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: 'Plan dropdown opened (focus-loss check)' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.includes('GPT 3.5 Turbo'))`);
  await cdp.waitFor(planBusy, { timeoutMs: 2_000, label: 'Plan radiogroup busy: the GPT 3.5 Turbo model save is in flight' });
  await cdp.click(`document.getElementById('model-role-plan-reasoning-auto')`);
  await cdp.waitFor(`window.refract.modelRoles.list().then((r) => r.ok && r.value.plan === 'github-copilot/gpt-3.5-turbo')`, {
    timeoutMs: 8_000,
    label: 'The GPT 3.5 Turbo save lands bare -- :auto cannot be carried'
  });
  await sleep(500);
  const focusedAfterUnmountingToken = await cdp.evaluate(`document.activeElement?.id ?? null`);
  assertTrue(focusedAfterUnmountingToken !== null && focusedAfterUnmountingToken.startsWith('model-role-plan-reasoning-'), `Focus stays inside Plan's radiogroup (never <body>) when the focused Auto radio's token can no longer be carried (got ${focusedAfterUnmountingToken})`, findings, failures);
  const rolesAfter = await cdp.evaluate(`window.refract.modelRoles.list().then((r) => (r.ok ? r.value : null))`);
  assertEqual(rolesAfter?.plan, 'github-copilot/gpt-3.5-turbo', 'Activating the kept Auto radio never wrote :auto back onto a model that cannot carry it', findings, failures);
}
