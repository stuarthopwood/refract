// Extra live checks for scripts/verify-tauri-008.mjs: menu arrow keys (FR-024), GitHub CLI states (FR-014), the
// update entry (FR-021), dialog focus return and the Health check screenshot. Selectors are role/name based.
import path from 'node:path';
import { sleep } from './verify-tauri-cdp.mjs';
import { pressKey, pressEscape } from './verify-tauri-session-list-helpers.mjs';

const KEYS = { up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'] };
const arrow = (cdp, dir) => pressKey(cdp, KEYS[dir][0], KEYS[dir][1], KEYS[dir][1]);
const FOCUSED_TEXT = `(document.activeElement?.textContent || '').trim()`;
const FOCUSED_ROLE = `document.activeElement?.getAttribute('role') || ''`;
const MENU_ITEMS = `Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))`;
const UPDATE_LABELS = ['Restart to update', 'Check for updates', 'Checking for updates', 'Downloading update', 'Installing update'];

async function openMenu(cdp, nameButton) {
  await cdp.click(nameButton);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'profile menu open' });
}
async function pickItem(cdp, text) {
  await cdp.click(`${MENU_ITEMS}.find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`);
}

/** FR-024: arrows walk the items, enter and leave the Theme submenu, Esc closes, focus returns to the profile item. */
export async function checkMenuKeyboard(cdp, { nameButton, assert }) {
  await openMenu(cdp, nameButton);
  await arrow(cdp, 'down');
  await cdp.waitFor(`${FOCUSED_ROLE} === 'menuitem'`, { timeoutMs: 5_000, label: 'ArrowDown focuses a menu item' });
  const first = await cdp.evaluate(FOCUSED_TEXT);
  await arrow(cdp, 'down');
  await sleep(100);
  assert((await cdp.evaluate(FOCUSED_TEXT)) !== first, 'ArrowDown moves focus to the next menu item (FR-024)');
  await arrow(cdp, 'up');
  await sleep(100);
  assert((await cdp.evaluate(FOCUSED_TEXT)) === first, 'ArrowUp moves focus back to the previous menu item (FR-024)');

  let onTheme = false;
  for (let i = 0; i < 12 && !onTheme; i++) {
    await arrow(cdp, 'down');
    onTheme = await cdp.evaluate(`${FOCUSED_TEXT}.startsWith('Theme')`);
  }
  assert(onTheme, 'ArrowDown reaches the Theme item (FR-024)');
  await arrow(cdp, 'right');
  await cdp.waitFor(`${FOCUSED_ROLE} === 'menuitemradio'`, { timeoutMs: 5_000, label: 'ArrowRight moves focus into the Theme submenu' });
  assert(await cdp.evaluate(`${FOCUSED_ROLE} === 'menuitemradio'`), 'ArrowRight moves focus into the Theme submenu (FR-024)');
  await arrow(cdp, 'left');
  await cdp.waitFor(`${FOCUSED_TEXT}.startsWith('Theme')`, { timeoutMs: 5_000, label: 'ArrowLeft returns focus to Theme' });
  assert(await cdp.evaluate(`${FOCUSED_TEXT}.startsWith('Theme')`), 'ArrowLeft moves focus out of the Theme submenu (FR-024)');
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Esc closes the menu (FR-024)' });
  await cdp.waitFor(`document.activeElement === ${nameButton}`, { timeoutMs: 5_000, label: 'focus returns to the profile item' });
  assert(await cdp.evaluate(`!document.querySelector('[role="menu"]') && document.activeElement === ${nameButton}`), 'Esc closes the menu and focus returns to the profile item (FR-024)');
}

/** FR-014 and FR-021: the first menu row and Manage accounts agree with the gh state; the update entry has a known verb. */
export async function checkGithubCliAndUpdate(cdp, { nameButton, assert, log }) {
  await openMenu(cdp, nameButton);
  const items = await cdp.evaluate(`${MENU_ITEMS}.map((el) => el.textContent.trim())`);
  const hasInstall = await cdp.evaluate(`!!document.querySelector('[role="menu"] a[href="https://cli.github.com"]')`);
  const hasSignIn = items.some((t) => t.startsWith('Sign in to GitHub'));
  log(`gh state in the menu: install link ${hasInstall}, sign-in row ${hasSignIn}`);
  assert(hasInstall || hasSignIn || items.some((t) => /Manage accounts/.test(t)), 'the profile menu reflects the gh state: Install, Sign in, or a signed-in account (FR-014)');
  const update = items.find((t) => UPDATE_LABELS.some((l) => t.startsWith(l)));
  assert(!!update, `the update entry reads one of the FR-021 verbs ("${update}")`);
  await pickItem(cdp, 'Manage accounts');
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] section[aria-labelledby]')`, { timeoutMs: 20_000, label: 'Manage accounts open' });
  const dialog = await cdp.evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return { install: !!d.querySelector('a[href="https://cli.github.com"]'), text: d.innerText }; })()`);
  assert(dialog.install === hasInstall, 'Manage accounts shows the Install link exactly when the profile menu does (FR-014)');
  if (hasSignIn) assert(/sign in/i.test(dialog.text), 'Manage accounts offers a Sign in action when gh is installed but signed out (FR-009, FR-014)');
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Manage accounts closed' });
}

/** Opens a dialog from the menu, optionally runs `inside`, closes it with Esc and asserts focus is back on the profile item. */
export async function checkDialogFocusReturn(cdp, { nameButton, assert, itemText, readyExpr, inside }) {
  await openMenu(cdp, nameButton);
  await pickItem(cdp, itemText);
  await cdp.waitFor(readyExpr, { timeoutMs: 60_000, label: `${itemText} dialog ready` });
  if (inside) await inside();
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: `${itemText} dialog closed` });
  await cdp.waitFor(`document.activeElement === ${nameButton}`, { timeoutMs: 5_000, label: `focus returns after ${itemText}` });
  assert(await cdp.evaluate(`document.activeElement === ${nameButton}`), `focus returns to the profile item after the ${itemText} dialog closes`);
}

export const DIALOG_OPEN = `!!document.querySelector('[role="dialog"]')`;
export const HEALTH_SETTLED = `!!document.querySelector('[role="dialog"] [aria-label="Health checks"]') && !document.querySelector('[role="dialog"] [aria-label="Health checks"][aria-busy="true"]')`;
export const healthShot = (cdp, shotsDir) => cdp.screenshot(path.join(shotsDir, 'theme-dark-health-check.png'));
