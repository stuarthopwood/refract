// Pill reads and the pinned and queued captures for verify-tauri-1878.mjs, split out for the file-size cap.
// `check(label, ok, detail)` is the caller's recorder; nothing here touches the Session beyond the named step.
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { getAccessibleNameAndRole } from './verify-tauri-scratch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';

export const PILL = `document.querySelector('[data-role-model-pill]')`;
export const PROVIDER = 'GitHub Copilot';
export const LONG_MODEL_ID = 'claude-fable-5-the-sixty-plus-character-example-model-name';
const MESSAGE = `document.querySelector('[aria-label="Message"]')`;
const CTRL = 2;

const shortName = (name) => name.replace(/^claude\s+/i, '');

async function pressKey(cdp, code, name, modifiers = 0) {
  const keyCode = `Key${name.toUpperCase()}`;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name, code: keyCode, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name, code: keyCode, modifiers });
}

/** A real Tab sequence from the message box (bounded, no exact count), never `.focus()`: only keyboard focus
 * proves the pill is reachable and that its tooltip opens for a keyboard user. */
export async function focusPillByTab(cdp) {
  await cdp.click(MESSAGE);
  // The composer's Tab indents by default (#1513); Ctrl+M is the documented switch to Tab moving focus.
  const movesFocus = `document.body.textContent.includes('Tab moves focus.')`;
  if (!(await cdp.evaluate(movesFocus))) await pressKey(cdp, 77, 'm', CTRL);
  for (let i = 0; i < 10; i++) {
    await pressTab(cdp);
    if (await cdp.evaluate(`(${PILL}) === document.activeElement`)) return true;
  }
  return false;
}

/** Tabs onto the pill and returns the tooltip text that opened on that focus. */
async function tooltipAfterTab(cdp, check, prefix) {
  const reached = await focusPillByTab(cdp);
  check(`${prefix}: Tab from the message box reaches the pill`, reached, reached ? undefined : await cdp.evaluate(`document.activeElement?.outerHTML?.slice(0, 200) + ' | hasFocus=' + document.hasFocus()`));
  check(`${prefix}: the pill matches :focus-visible after a real Tab`, await cdp.evaluate(`(${PILL}).matches(':focus-visible')`));
  await cdp.waitFor(`!!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 10_000, label: 'tooltip on focus' }).catch(() => {});
  await sleep(300);
  return cdp.evaluate(`document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null`);
}

async function checkAxName(cdp, check, prefix, expected) {
  const ax = await getAccessibleNameAndRole(cdp, `(${PILL})`);
  const ok = typeof expected === 'string' ? ax.name === expected : expected.test(ax.name ?? '');
  check(`${prefix}: the AX tree names the pill ${expected}`, ok && ax.role === 'button', ax);
}

async function sessionSummary(cdp, sessionId) {
  const list = await cdp.evaluate(`window.refract.sessions.list()`);
  return list.ok ? list.value.find((s) => s.id === sessionId) : undefined;
}

/** A Session on a role: the pill reads the role alone; the focus tooltip carries the full model name and provider. */
export async function inspectRolePill(cdp, check, sessionId, expectedRole, shotsDir, prefix) {
  await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'role-model pill rendered' });
  // The role arrives from Rust right after launch; give the first paint a fair chance, then record whatever shows.
  await cdp.waitFor(`(${PILL}).textContent.trim() === ${JSON.stringify(expectedRole)}`, { timeoutMs: 15_000, label: `pill reads ${expectedRole}` }).catch(() => {});
  const summary = await sessionSummary(cdp, sessionId);
  const text = await cdp.evaluate(`(${PILL}).textContent.trim()`);
  const modelName = summary?.lastModel ? summary.lastModel.name?.trim() || summary.lastModel.id : null;
  check(`${prefix}: Rust reports currentRole ${expectedRole.toLowerCase()}`, summary?.currentRole === expectedRole.toLowerCase(), summary?.currentRole);
  check(`${prefix}: the pill's visible text is the role only`, text === expectedRole, text);
  check(`${prefix}: the pill's visible text does not contain the model name`, modelName !== null && !text.includes(shortName(modelName)), { text, modelName });
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip.png`));
  const tip = await tooltipAfterTab(cdp, check, prefix);
  check(`${prefix}: the focus tooltip reads role, full model and provider`, tip?.includes(`${expectedRole} role: ${modelName} via ${PROVIDER}. Ctrl+R cycles roles.`) ?? false, tip);
  await checkAxName(cdp, check, prefix, `${expectedRole} role, ${modelName} model`);
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip-tooltip.png`));
}

/** A Session on a directly picked model whose name is far longer than the pill: it shows the model with a pin
 * glyph, truncates inside its own box, and the tooltip says how to return to a role. */
export async function inspectPinnedPill(cdp, check, sessionId, shotsDir, prefix) {
  await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'role-model pill rendered' });
  // A hand pick made before the launch settles is queued for the next turn rather than applied, so wait for an enabled composer.
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled before the hand pick' });
  const picked = await cdp.evaluate(`window.refract.model.setModel(${JSON.stringify(sessionId)}, 'github-copilot', ${JSON.stringify(LONG_MODEL_ID)})`);
  check(`${prefix}: model.setModel accepts the hand pick`, picked.ok === true, picked);
  await cdp.waitFor(`(${PILL}).querySelector('[class*="lucide-pin"]') !== null`, { timeoutMs: 15_000, label: 'pin glyph on the pill' }).catch(() => {});
  // Rust flips `pinned` after it processes the set_model response, which can trail the pill glyph.
  let summary = await sessionSummary(cdp, sessionId);
  for (const deadline = Date.now() + 15_000; summary?.pinned !== true && Date.now() < deadline;) {
    await new Promise((r) => setTimeout(r, 250));
    summary = await sessionSummary(cdp, sessionId);
  }
  const modelName = summary?.lastModel ? summary.lastModel.name?.trim() || summary.lastModel.id : null;
  const probe = await cdp.evaluate(`(() => {
    const pill = ${PILL};
    const row = document.querySelector('[data-composer-row]');
    const pillBox = pill.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return {
      text: pill.textContent.trim(),
      pin: pill.querySelector('[class*="lucide-pin"]') !== null,
      truncated: Array.from(pill.querySelectorAll('span')).some((s) => s.scrollWidth > s.clientWidth),
      insideRow: pillBox.width > 0 && pillBox.left >= rowBox.left - 1 && pillBox.right <= rowBox.right + 1
    };
  })()`);
  check(`${prefix}: Rust reports the Session pinned with no role`, summary?.pinned === true && summary?.currentRole == null, { pinned: summary?.pinned, currentRole: summary?.currentRole });
  check(`${prefix}: the pill shows the model name with a pin glyph`, modelName !== null && probe.text === shortName(modelName) && probe.pin, probe);
  check(`${prefix}: a long model name truncates inside the pill and the pill stays inside the composer row`, probe.truncated && probe.insideRow, probe);
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip.png`));
  const tip = await tooltipAfterTab(cdp, check, prefix);
  check(`${prefix}: the focus tooltip reads the pinned model, provider and the way back`, tip?.includes(`Pinned to ${modelName} via ${PROVIDER}. Ctrl+R returns to a role.`) ?? false, tip);
  await checkAxName(cdp, check, prefix, `Pinned, ${modelName} model`);
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip-tooltip.png`));
}

/** The tape has no role apply before the turn, so the only Ctrl+R is the one during the stream: it queues the next
 * role (Rust holds it as pendingSelection) and the pill shows the clock glyph. */
export async function inspectQueuedPill(cdp, check, sessionId, shotsDir, prefix) {
  await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'role-model pill rendered' });
  await cdp.click(MESSAGE);
  await cdp.send('Input.insertText', { text: 'hello' });
  await cdp.pressEnter();
  await cdp.waitFor(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sessionId)}).status === 'working')`, { timeoutMs: 20_000, label: 'session status working' });
  await cdp.evaluate(`${MESSAGE}.focus()`);
  await pressKey(cdp, 82, 'r', CTRL);
  await cdp.waitFor(`!!(${PILL}).querySelector('[data-pending-glyph]')`, { timeoutMs: 10_000, label: 'pending clock glyph' }).catch(() => {});
  check(`${prefix}: the pill shows the pending clock glyph`, await cdp.evaluate(`!!(${PILL}).querySelector('[data-pending-glyph]')`));
  await sleep(1500); // the 600 ms Ctrl+R debounce, so Rust holds the pending role before the tooltip is read
  const queuedRole = (await sessionSummary(cdp, sessionId))?.pendingSelection?.role ?? null;
  check(`${prefix}: Rust holds the queued role`, typeof queuedRole === 'string', queuedRole);
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip.png`));
  const label = queuedRole === 'slow' ? 'Slow' : '';
  const tip = await tooltipAfterTab(cdp, check, prefix);
  check(`${prefix}: the queued tooltip leads with the new value and its model, then names what runs now`, new RegExp(`^${label} \\([^)]+\\) applies on next turn\\. Now: Default · .+\\.$`).test(tip ?? ''), tip);
  await checkAxName(cdp, check, prefix, new RegExp(`^${label} role, .+ model, applies next turn\$`));
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip-tooltip.png`));
}
