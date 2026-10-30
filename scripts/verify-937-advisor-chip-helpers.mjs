// Shared helpers for verify-937-advisor-chip.mjs (split for the file-size cap): notice detection,
// AX reads, geometry, live-region polling and the final `/advisor status` log, for either activation method.
import path from 'node:path';

const MESSAGE_FINDER = `document.querySelector('[aria-label="Message"]')`;
const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;

// Same `NoticeRow` finder as verify-917-advisor-command.mjs: survives `react-virtuoso` windowing and
// works whether the row is a plain `<div>` or a `<CollapsibleTrigger>` button. Duplicated, not imported.
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

/** Leak scan: must run BEFORE this script's own first `/advisor status` (its real reply would match
 * the same pattern). Proves no status-reply-shaped notice (`Advisor is ...`, `Spend` figure) leaked
 * and the probe's command text was never echoed as a user message. A clean scan cannot prove the
 * silent probe actually fired, so the caller records that in `notExercised`. */
export async function assertNoProbeLeak(cdp, findings, failures, notExercised, label) {
  const texts = await allNoticeTexts(cdp);
  // `Spend` is scoped to lines starting "Advisor ", so an unrelated cost notice is not flagged as a leak.
  const leaked = texts.filter((t) => /^Advisor (is |")/.test(t) || (/^Advisor /.test(t) && /Spend/.test(t)));
  if (leaked.length > 0) {
    failures.push(
      `${label}: a status-reply-shaped notice leaked into the transcript (the silent probe's own reply must never render): ${JSON.stringify(leaked)}`
    );
  } else {
    findings.push(`${label}: no leaked status-reply-shaped notice found in the transcript.`);
  }
  const echoed = await cdp.evaluate(`(${TRANSCRIPT})?.textContent?.includes('/advisor status') ?? false`);
  if (echoed) {
    failures.push(`${label}: the literal text "/advisor status" was found in the transcript -- the silent probe must never be echoed as a user message.`);
  } else {
    findings.push(`${label}: the silent probe's own command text was never echoed anywhere in the transcript.`);
  }
  notExercised.push(
    `${label}: whether the silent attach/resume probe actually FIRED (as opposed to never running at all -- an omp build without \`advisor\` listed yet, or still mid-idle-wait) cannot be proven from this script's own CDP read; the clean scan above is consistent with either outcome, recorded as a finding, not asserted as proof the probe ran.`
  );
}

async function clearComposer(cdp) {
  const current = await cdp.evaluate(`${MESSAGE_FINDER}?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
  }
  await cdp.waitFor(`(${MESSAGE_FINDER}?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

/** Sends a slash command as real typed text and waits for a NEWLY-mounted notice matching
 * `expectedPattern` (an ambient profile can mount an unrelated system notice in the same window). */
export async function sendSlashCommand(cdp, command, expectedPattern, { timeoutMs = 60_000 } = {}) {
  await clearComposer(cdp);
  const before = (await allNoticeTexts(cdp)).length;
  await cdp.click(MESSAGE_FINDER);
  await cdp.send('Input.insertText', { text: command });
  await cdp.clickByLabel('Send message');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = await allNoticeTexts(cdp);
    const match = texts.slice(before).find((t) => expectedPattern.test(t));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`sendSlashCommand: no notice matching ${expectedPattern} appeared within ${timeoutMs}ms for "${command}".`);
}

/** The Advisor chip's `ReadoutItem` button, found by its `aria-hidden` text span (the icon carries
 * no text, so it never double-matches). `null` once the chip is hidden (advisor off). */
const ADVISOR_CHIP_FINDER =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor')`;

/** Any OTHER `[data-slot="readout-chip"]` than the Advisor chip, for geometry comparison. `null`
 * is a loggable `notExercised` case (Settings' per-kind visibility), not a failure. */
const OTHER_CHIP_FINDER =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() !== 'Advisor')`;

export async function readChipGeometry(cdp, finderExpr) {
  return cdp.evaluate(`(() => {
    const el = ${finderExpr};
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const icon = el.querySelector('svg');
    const iconRect = icon ? icon.getBoundingClientRect() : null;
    return {
      rowHeight: Math.round(rect.height),
      iconSize: iconRect ? { width: Math.round(iconRect.width), height: Math.round(iconRect.height) } : null
    };
  })()`);
}

export async function readAdvisorChipGeometry(cdp) {
  return readChipGeometry(cdp, ADVISOR_CHIP_FINDER);
}

export async function readOtherChipGeometry(cdp) {
  return readChipGeometry(cdp, OTHER_CHIP_FINDER);
}

export async function advisorChipPresent(cdp) {
  return cdp.evaluate(`!!(${ADVISOR_CHIP_FINDER})`);
}

/** The composer's shared attachment live region (`#${sessionId}-attachments-status`), found by id
 * suffix because the scratch Session id is unknown; one composer is mounted, so it is unambiguous. */
const LIVE_REGION_FINDER = `document.querySelector('[id$="-attachments-status"]')`;

export async function readLiveRegionText(cdp) {
  return cdp.evaluate(`(${LIVE_REGION_FINDER})?.textContent ?? null`);
}

/** Tags the span currently in the live region with a marker BEFORE a cycle activates the chip;
 * each real announcement gets a fresh DOM node (`key={seq}`), so the marker only sticks to stale ones. */
export async function markLiveRegionSeen(cdp) {
  await cdp.evaluate(
    `(() => { const el = (${LIVE_REGION_FINDER})?.firstElementChild; if (el) el.setAttribute('data-937-seen', '1'); return true; })()`
  );
}

/** Polls for a NEW (unmarked by `markLiveRegionSeen`) live-region span containing
 * `expectedSubstring`; a plain text check could pass on a stale span from an earlier cycle. */
export async function waitForFreshLiveRegionText(cdp, expectedSubstring, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await cdp.evaluate(
      `(() => { const el = (${LIVE_REGION_FINDER})?.firstElementChild; return !!(el && !el.hasAttribute('data-937-seen') && (el.textContent ?? '').includes(${JSON.stringify(expectedSubstring)})); })()`
    );
    if (matched) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function activeElementIsMessageBox(cdp) {
  return cdp.evaluate(`document.activeElement === ${MESSAGE_FINDER}`);
}

/** Walks a real Shift+Tab chain BACKWARD from the message textarea until an element whose
 * `aria-label` starts with "Advisor on." is focused, or throws after `stepCap` tabs. The status
 * line renders BEFORE the textarea, so forward Tab never reaches it; the chip is last in the
 * left group, so a small cap catches a regression where it moves or stops rendering. */
export async function tabToAdvisorChip(cdp, pressShiftTab, { stepCap = 8 } = {}) {
  for (let i = 0; i < stepCap; i++) {
    await pressShiftTab(cdp);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const label = await cdp.evaluate(`document.activeElement?.getAttribute('aria-label') ?? null`);
    if (label && label.startsWith('Advisor on.')) return true;
  }
  return false;
}

/** One full on -> toggle-off cycle via a real mouse click or real keyboard Shift+Tab+Enter,
 * asserting the chip, busy-window no-op, "Advisor disabled." notice, AX removal, focus return
 * to the textarea and the "Advisor off" announcement. */
export async function runAdvisorToggleCycle(cdp, { mode, pressShiftTab, pressEnterKey, shotsDir, findings, failures }) {

  const tag = `[${mode}]`;
  await sendSlashCommand(cdp, '/advisor on', /Advisor enabled\./);
  findings.push(`${tag} "/advisor on" produced the authoritative enable reply.`);

  // `waitFor`: the chip's `advisor:update` IPC can trail the notice by a tick or two.
  try {
    await cdp.waitFor(`!!(${ADVISOR_CHIP_FINDER})`, { timeoutMs: 5_000, label: `${tag} Advisor chip appeared after "/advisor on"` });
  } catch (err) {
    failures.push(`${tag} ${err.message}`);
    return;
  }

  // Scoped to this activation, so the other cycle's leftovers cannot satisfy the check.
  const noticeCountBeforeActivate = (await allNoticeTexts(cdp)).length;
  await markLiveRegionSeen(cdp);

  if (mode === 'mouse') {
    await cdp.click(ADVISOR_CHIP_FINDER);
  } else {
    await clearComposer(cdp);
    await cdp.click(MESSAGE_FINDER);
    const reached = await tabToAdvisorChip(cdp, pressShiftTab);
    if (!reached) {
      failures.push(`${tag} could not Shift+Tab to the Advisor chip within the step cap.`);
      return;
    }
    await pressEnterKey(cdp);
  }

  // Busy window: the name reads "Turning off…" and a repeat activation is a no-op (`if (turningOff) return`).
  await new Promise((resolve) => setTimeout(resolve, 50));
  const busyLabelBefore = await cdp.evaluate(`document.querySelector('[aria-label^="Advisor on. Turning off"]') ? 'busy' : 'not-busy'`);
  if (busyLabelBefore === 'busy') {
    findings.push(`${tag} busy accessible name "Advisor on. Turning off…" observed.`);
    if (mode === 'mouse') await cdp.click(ADVISOR_CHIP_FINDER).catch(() => {});
    else await pressEnterKey(cdp);
    // "Chip already gone" is inconclusive (the first toggle may have finished); the single-notice count is the real proof.
    const chipGoneAfterRepeat = await cdp.evaluate(`!(${ADVISOR_CHIP_FINDER})`);
    if (chipGoneAfterRepeat) {
      findings.push(`${tag} the chip was already gone by the time the repeat activation's own effect could be checked -- inconclusive here; see the exactly-one "Advisor disabled." count below for the real proof.`);
    } else {
      const stillBusy = await cdp.evaluate(`document.querySelector('[aria-label^="Advisor on. Turning off"]') ? true : false`);
      if (!stillBusy) failures.push(`${tag} a repeat activation during the busy window did not stay in the busy state (expected a no-op).`);
      else findings.push(`${tag} a repeat activation during the busy window was a no-op, as expected.`);
    }
  } else {
    findings.push(`${tag} the busy window closed before it could be observed (a fast real reply) -- not a failure, just too quick to catch.`);
  }

  try {
    await cdp.waitFor(`!(${ADVISOR_CHIP_FINDER})`, { timeoutMs: 30_000, label: `${tag} Advisor chip removed from the DOM/AX tree` });
    findings.push(`${tag} Advisor chip left the AX tree once the toggle settled.`);
  } catch (err) {
    failures.push(`${tag} ${err.message}`);
  }

  // Counted at the end: a queued duplicate `/advisor off` can settle its reply after the status call below.

  // Checked before the status probe below, which clicks the message box and would make focus checks vacuous.
  const focusOk = await activeElementIsMessageBox(cdp);
  if (focusOk) findings.push(`${tag} focus landed on the message textarea after the chip's own toggle-off.`);
  else failures.push(`${tag} focus did NOT land on the message textarea after the chip's own toggle-off.`);

  const announced = await waitForFreshLiveRegionText(cdp, 'Advisor off');
  if (announced) findings.push(`${tag} a NEW "Advisor off" announcement was observed in the composer's shared attachment live region.`);
  else failures.push(`${tag} no NEW "Advisor off" announcement was observed in the composer's shared attachment live region within the timeout.`);

  // Supplementary: logs the real wording (ambiguous per `session::advisor`), never asserts it. Runs
  // last because it clicks the message box.
  const statusReply = await sendSlashCommand(cdp, '/advisor status', /advisor/i).catch((err) => `<no reply: ${err.message}>`);
  findings.push(`${tag} supplementary "/advisor status" reply (wording not asserted, see this file's own header): ${JSON.stringify(statusReply)}`);

  // Sliced from `noticeCountBeforeActivate` so earlier cycles' leftovers never count; exactly one
  // is required, since more means a duplicate send or an extra reply.
  const noticesSinceActivate = (await allNoticeTexts(cdp)).slice(noticeCountBeforeActivate);
  const newDisabledNotices = noticesSinceActivate.filter((t) => /Advisor disabled\./.test(t));
  if (newDisabledNotices.length === 1) {
    findings.push(`${tag} exactly one NEW authoritative "Advisor disabled." reply confirmed (not a leftover from an earlier cycle, no later duplicate).`);
  } else {
    failures.push(`${tag} expected exactly one NEW "Advisor disabled." notice since this cycle's own activation, found ${newDisabledNotices.length}.`);
  }

  await cdp.screenshot(path.join(shotsDir, `${mode}-cycle-after-toggle-off.png`));
}
