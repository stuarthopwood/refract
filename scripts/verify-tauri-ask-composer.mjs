// Composer checks run after the Ask card flow: status-line pill gap (#1429) and spelling suggestions (#1431).
import path from 'node:path';

const FIELD = `document.querySelector('[aria-label="Message"]')`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runComposerChecks(cdp, shotDir, assert) {
  const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
  const rightClickField = async () => {
    const p = await cdp.evaluate(`(() => { const r = ${FIELD}.getBoundingClientRect(); return { x: r.x + 14, y: r.y + 14 }; })()`);
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p, { button: 'right', clickCount: 1 });
    await mouse('mouseReleased', p, { button: 'right', clickCount: 1 });
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'composer menu open' });
    await sleep(600);
  };
  const menuTexts = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => i.textContent.trim())`);
  const clickMenuItem = async (text) => {
    const p = await cdp.evaluate(`(() => { const i = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p, { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', p, { button: 'left', clickCount: 1 });
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'composer menu closed' });
    await sleep(300);
  };
  const setText = async (text) => {
    await cdp.click(FIELD);
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await cdp.send('Input.insertText', { text });
    await sleep(200);
  };

  await cdp.waitFor(`(() => { const el = ${FIELD}; return !!el && !el.disabled; })()`, { timeoutMs: 30_000, label: 'Composer enabled for spelling check' });
  const gap = await cdp.evaluate(`(() => { const el = document.querySelector('[data-slot="composer-status-line"]'); return el ? getComputedStyle(el).columnGap : null; })()`);
  console.log(`verify-tauri-ask: status line column-gap ${gap}`);
  assert(gap === '16px', `status line pills should be 16px apart (gap-x-4): ${gap}`);
  await cdp.screenshot(path.join(shotDir, '06-composer-status-line.png'));

  await setText('teh quick');
  await rightClickField();
  const items = await menuTexts();
  console.log(`verify-tauri-ask: menu after right-click on "teh": ${JSON.stringify(items)}`);
  await cdp.screenshot(path.join(shotDir, '07-spelling-menu.png'));
  assert(items.some((t) => t === 'the'), `spelling suggestions should include "the": ${JSON.stringify(items)}`);
  assert(items.some((t) => t.startsWith('Add')), `menu should offer Add to dictionary: ${JSON.stringify(items)}`);
  await clickMenuItem('the');
  const replaced = await cdp.evaluate(`${FIELD}.value`);
  assert(replaced === 'the quick', `choosing "the" should replace the word: ${JSON.stringify(replaced)}`);

  await setText('refrct quick');
  await rightClickField();
  const before = await menuTexts();
  const addEntry = before.find((t) => t.startsWith('Add'));
  assert(!!addEntry, `a misspelt word should offer Add to dictionary: ${JSON.stringify(before)}`);
  await clickMenuItem('Add');
  await rightClickField();
  const after = await menuTexts();
  console.log(`verify-tauri-ask: menu on the added word: ${JSON.stringify(after)}`);
  await cdp.screenshot(path.join(shotDir, '08-after-add-to-dictionary.png'));
  assert(!after.some((t) => t.startsWith('Add')), `the added word should no longer offer suggestions: ${JSON.stringify(after)}`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
