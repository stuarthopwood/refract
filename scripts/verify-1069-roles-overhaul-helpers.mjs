// Shared helpers for `verify-1069-roles-overhaul.mjs` (issue #1069, gate round 1/#1114), split
// out only to keep the main script's own line count comfortably under the project's 600-line
// soft cap (`AGENTS.md` rule 11) once this round's new assertions landed -- the same precedent
// `verify-941-stage-naming-helpers.mjs` and its siblings already set for this family of scripts.
import { readFileSync } from 'node:fs';
import { sleep } from './verify-tauri-cdp.mjs';

/** The provider switch's own visible-label `aria-labelledby` target (`ProviderSwitch.tsx`, gate
 * round 1 Medium #7: a plain `aria-label="Provider"` was replaced by a real visible "Show models
 * from" label, so every selector below targets the switch by that label's own fixed id instead. */
export const PROVIDER_SWITCH_SELECTOR = '[aria-labelledby="model-role-provider-switch-label"]';

/** Counts `omp config set` one-shot CLI invocations recorded in the fake-omp debug log
 * (`REFRACT_FAKE_OMP_DEBUG_LOG`, one `pid=... argv=[...]` line per subprocess spawn, written
 * before `verify-tauri-fake-omp.mjs` even looks at `argv[0]`) -- the ground-truth signal for
 * "how many real writes actually landed", used to prove latest-pick-wins coalescing costs at
 * most one extra write, never one per keypress (gate round 1, High #1). */
export function countConfigSetCalls(logPath) {
  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return 0;
  }
  return content.split('\n').filter((line) => line.includes('"config","set"')).length;
}

/** The combined, visible reason caption a role's own reasoning radiogroup renders (gate round 1,
 * High #4: ONE caption per role, e.g. "Medium, High and Extra high aren't supported by GPT 3.5
 * Turbo" or "Pick a model first" -- never a per-item screen-reader-only reason read twice). */
export async function readReasonCaption(cdp, role) {
  return cdp.evaluate(`document.getElementById(${JSON.stringify(`model-role-${role}-label-reasoning-reason`)})?.textContent.trim() ?? null`);
}

/** Keyboard-switches the provider `ToggleGroup` to `targetText`, assuming the CURRENTLY selected
 * segment already has real DOM focus (the caller's own `.focus()` call, never this helper's own
 * shortcut, keeps the keyboard-only claim unambiguous). Reads and records the segment state after
 * the arrow key ALONE before pressing anything else: Radix's `ToggleGroup` "single" mode
 * deselects an ALREADY-selected item on a second activation (`ManageSessionsToolbar.tsx`'s own
 * header comment), so if arrow navigation itself already moves the selection (radiogroup-style),
 * a further Space/Enter on the now-selected item would wrongly deselect it -- Space is sent only
 * when the arrow move alone did not select. Every read polls (`cdp.waitFor`) rather than reading
 * once immediately after dispatching a key: a one-shot read raced React's own re-render in
 * earlier runs of this exact check (non-deterministic pass/fail against identical actions),
 * confirmed by comparing two runs' `report.json` side by side -- a real script bug, not a product
 * one. */
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

/** A role's own trigger text (the `SelectValue`'s rendered content), closed-state -- no need to
 * open the popup, Radix mirrors the matched item's children into the trigger either way. */
export async function readTriggerText(cdp, role) {
  return cdp.evaluate(`document.getElementById('model-role-${role}')?.textContent.trim() ?? null`);
}

/** Opens a role's own Select, reads every real `[role="option"]`'s visible text, then closes it
 * with Escape -- never a shortcut past the actual Radix popup. */
export async function readDropdownItemTexts(cdp, role) {
  await cdp.click(`document.getElementById('model-role-${role}')`);
  await cdp.waitFor(`!!document.querySelector('[role="listbox"]')`, { timeoutMs: 10_000, label: `${role}: dropdown opened` });
  const texts = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent.trim())`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="listbox"]')`, { timeoutMs: 5_000, label: `${role}: dropdown closed` });
  return texts;
}

/** One reasoning-radio item's own disabled/checked state, read by its fixed DOM id
 * (`model-role-<role>-reasoning-<level>`, `RoleReasoningRadios.tsx`'s own convention). The
 * combined visible reason caption is read separately (`readReasonCaption`, per group not per
 * item -- gate round 1, High #4). */
export async function readRadioState(cdp, role, level) {
  return cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(`model-role-${role}-reasoning-${level}`)});
    if (!el) return null;
    return { exists: true, disabled: el.disabled === true, checked: el.getAttribute('data-state') === 'checked' };
  })()`);
}

/** Gate round 3 fix (decision 2/3): a level held during the radios' OWN write survives that
 * write settling, but is DROPPED -- no write, no announcement -- if the Settings section
 * unmounts mid-save. Picks Medium for Default (starts the radios' own write), waits for it to
 * be genuinely in flight, holds a SECOND pick (Low) by clicking it mid-save, then leaves the
 * Model roles section entirely (navigating to Appearance, unmounting `RoleReasoningRadios`)
 * before that first write even lands -- then navigates back for the caller's own remaining
 * checks. `assertEqual`/`assertTrue` are passed in (not imported) to avoid a reverse dependency
 * on the main script, which already imports from this file. */
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

/** Fix (Main, post-review of gate round 3): a REFUSED click still focuses the radio it hit, even
 * though no state changes. If that level is supported by the OLD model but NOT the new one once
 * the Select's save lands, the focused item goes from enabled to natively disabled, and a naive
 * implementation lets the browser blur it to `<body>` (WCAG 2.4.3). Switches Default to Claude
 * Haiku 5.5 (thinking: minimal, low only -- no Extra high), clicks Extra high while the OLD model
 * (Opus 5.5, which DOES support it) is still showing, so the click is refused but still focuses
 * it; once Haiku lands, Extra high is natively disabled and focus must have already moved to the
 * checked item (Inherit, since Extra high isn't carryable to Haiku either), never `<body>`. */
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
  // The IPC read above only confirms the BACKEND file landed -- the app's OWN re-render (which
  // natively disables Extra high under the new model, and is what the layout-effect fix reacts
  // to) runs through a SEPARATE `setRole()` promise chain that can still be in flight a moment
  // later. Wait for the DOM's own disabled state directly, the actual proxy for "the component
  // has re-rendered", before reading `document.activeElement`.
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

/** #1127 finding 1 (WCAG 2.4.3): the focused Auto radio must not unmount under the user when a model
 * save lands that cannot carry `:auto`. Plan -> GPT 3.5 Turbo (no reasoning); the Auto click is
 * refused mid-save but still focuses it; once the save lands the stored value is bare, and focus
 * must NOT have fallen to `<body>`. */
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
