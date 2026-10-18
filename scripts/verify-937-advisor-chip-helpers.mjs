// Shared helpers for `scripts/verify-937-advisor-chip.mjs` (issue #937), split out to stay under
// the #806 600-line soft cap (`scripts/check-file-size.mjs`) once both the mouse-driven and
// keyboard-driven toggle cycles, the geometry comparison, and the live-region polling were all
// written out in full. Nothing here is specific to one run (mouse vs keyboard) -- the caller
// picks the activation method, everything else (notice detection, AX reads, geometry, the live
// region, the final `/advisor status` log) is identical either way.
import path from 'node:path';

const MESSAGE_FINDER = `document.querySelector('[aria-label="Message"]')`;
const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;

// Same `NoticeRow` structural finder `verify-917-advisor-command.mjs` already established and
// proved live (see that file's own header comment for why: survives `react-virtuoso`
// windowing, and climbing from the sr-only "Info:" label's icon-slot span to its row container
// works whether the row is a plain `<div>` or a `<CollapsibleTrigger>` button). Duplicated here
// rather than imported: it is a small, self-contained DOM-shape fact about `CollapsedLine`, the
// same precedent every other `verify-9xx-*.mjs` script's own inline copy already sets, not a
// piece of shared infrastructure like `CdpSession`/`getAccessibleNameAndRole`.
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

/** Gate round 1 fix (High, item 14): proves the silent attach/resume probe's own reply, IF the
 * probe fired for this brand-new Session's own `on_launch` (`session::advisor`'s own header),
 * never leaked into the visible transcript as anything other than the expected `/advisor on`
 * reply itself -- a status-reply-shaped notice (`Advisor is ...`, `Advisor "..."`, any `Spend`
 * figure) would mean `agent/frame.rs`'s own pre-dispatch veto failed to consume it. Also checks
 * the probe was never echoed as a literal user-authored message bubble (the probe is sent via
 * `request_rpc`, never through `chat.send`'s own transcript-mutating path -- defensive,
 * belt-and-braces, not expected to ever actually find one). */
export async function assertNoProbeLeak(cdp, findings, failures, label) {
  const texts = await allNoticeTexts(cdp);
  const leaked = texts.filter((t) => /Advisor (is |")|Spend/.test(t));
  if (leaked.length > 0) {
    failures.push(
      `${label}: a status-reply-shaped notice leaked into the transcript (the silent probe's own reply must never render): ${JSON.stringify(leaked)}`
    );
  } else {
    findings.push(`${label}: no leaked status-reply-shaped notice found (the silent attach probe, if it ran, never surfaced).`);
  }
  const echoed = await cdp.evaluate(`(${TRANSCRIPT})?.textContent?.includes('/advisor status') ?? false`);
  if (echoed) {
    failures.push(`${label}: the literal text "/advisor status" was found in the transcript -- the silent probe must never be echoed as a user message.`);
  } else {
    findings.push(`${label}: the silent probe's own command text was never echoed anywhere in the transcript.`);
  }
}

async function clearComposer(cdp) {
  const current = await cdp.evaluate(`${MESSAGE_FINDER}?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
  }
  await cdp.waitFor(`(${MESSAGE_FINDER}?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

/** Sends a slash command as real, visible typed text (used for `/advisor on` to seed each cycle,
 * and for the final `/advisor status` log -- never for the silent attach/resume probe, which
 * this script cannot drive without a second app restart, see the main script's own
 * `notExercised` entry). Waits for a NEWLY-mounted notice matching `expectedPattern`, same
 * not-just-the-latest-notice reasoning `verify-917-advisor-command.mjs` already documents (an
 * ambient signed-in profile can mount an unrelated system notice in the same short window). */
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

/** The Advisor chip's own `ReadoutChip` button, found by its `aria-hidden` visible-text span
 * (set by `AdvisorChip`) rather than by any text on the icon itself (the icon is also
 * `aria-hidden` but carries no text, so this never double-matches). `null` once the chip is
 * hidden (advisor off) -- the caller's own absence checks treat that as the expected, not an
 * error. */
const ADVISOR_CHIP_FINDER =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor')`;

/** Any OTHER status-line Readout chip, for the geometry comparison (item 3 of the issue's own
 * brief): picks the first `[data-slot="readout-chip"]` that is NOT the Advisor chip. `null`
 * (not a failure) when none of the session's other Readouts happen to be visible -- Settings'
 * own per-kind visibility means this is a genuine, loggable `notExercised` case, not a bug. */
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

/** The composer's shared attachment live region (`MessageInput.tsx`'s
 * `#${sessionId}-attachments-status`, `role="status" aria-live="polite"`) -- found by its own
 * `-attachments-status` id suffix rather than a hardcoded session id, since this script's own
 * scratch Session's id is never known in advance. Exactly one composer is ever mounted in this
 * script's single, unsplit pane, so the suffix match is unambiguous. */
const LIVE_REGION_FINDER = `document.querySelector('[id$="-attachments-status"]')`;

export async function readLiveRegionText(cdp) {
  return cdp.evaluate(`(${LIVE_REGION_FINDER})?.textContent ?? null`);
}

/** Gate round 1 fix (High, item 13): tags whatever span currently occupies the live region (if
 * any) with a marker attribute BEFORE a cycle activates the chip -- `useDraftStore`'s own
 * `attachmentAnnouncement.seq` gives each real announcement a fresh DOM node (`key={seq}`), so
 * the marker is never carried over onto a genuinely NEW announcement, only onto a stale one
 * left over from an earlier cycle or an unrelated attachment event. */
export async function markLiveRegionSeen(cdp) {
  await cdp.evaluate(
    `(() => { const el = (${LIVE_REGION_FINDER})?.firstElementChild; if (el) el.setAttribute('data-937-seen', '1'); return true; })()`
  );
}

/** Polls for a NEW (unmarked by `markLiveRegionSeen`) live-region span containing
 * `expectedSubstring`, or returns false at timeout -- gate round 1 fix (High, item 13): the
 * plain "does the CURRENT text contain it" check this replaces could pass on a stale span left
 * over from an earlier cycle's own announcement, never proving THIS cycle actually announced
 * anything. */
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

/** Walks a real keyboard Tab chain from the message textarea until an element whose
 * `aria-label` starts with "Advisor on." is focused, or throws after `stepCap` tabs -- the
 * Advisor chip renders LAST in `ComposerStatusLine.tsx`'s own left group (gate round 1
 * decision, right before the `ml-auto` Current time chip), so a small cap still reaches it from
 * the message textarea; a larger cap would hide a real regression (the chip moved, or stopped
 * rendering, far enough away that "eventually reachable" no longer means "where FR-078 sits"). */
export async function tabToAdvisorChip(cdp, pressTab, { stepCap = 8 } = {}) {
  for (let i = 0; i < stepCap; i++) {
    await pressTab(cdp);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const label = await cdp.evaluate(`document.activeElement?.getAttribute('aria-label') ?? null`);
    if (label && label.startsWith('Advisor on.')) return true;
  }
  return false;
}

/** One full on -> toggle-off cycle, driven either by a real mouse click or a real keyboard
 * Tab+Enter (never a scripted `.click()`/`.focus()` call), asserting every outcome the issue's
 * own brief lists for each activation method: the chip appears with "Advisor on. Turn off", a
 * repeat activation during the busy window is a no-op, the authoritative "Advisor disabled."
 * notice (plus a supplementary, real `/advisor status` -- its own wording not asserted to a
 * fixed pattern, per `session::advisor`'s own documented ambiguity), the chip leaves the AX
 * tree, focus lands on the message textarea, and "Advisor off" is announced. */
export async function runAdvisorToggleCycle(cdp, { mode, pressTab, pressEnterKey, shotsDir, findings, failures }) {
  const tag = `[${mode}]`;
  await sendSlashCommand(cdp, '/advisor on', /Advisor enabled\./);
  findings.push(`${tag} "/advisor on" produced the authoritative enable reply.`);

  // Gate round 1 fix (Medium, item 15): `cdp.waitFor`, not a single immediate `evaluate` -- the
  // notice above renders straight from the `command_output` frame, while the chip's own
  // `advisor:update` IPC event (store update, then a re-render) can trail it by a tick or two;
  // an immediate check can spuriously fail on a real, working chip that just hasn't painted yet.
  try {
    await cdp.waitFor(`!!(${ADVISOR_CHIP_FINDER})`, { timeoutMs: 5_000, label: `${tag} Advisor chip appeared after "/advisor on"` });
  } catch (err) {
    failures.push(`${tag} ${err.message}`);
    return;
  }

  // Gate round 1 fix (High, item 13): both scoped to what THIS activation produces, never what
  // an earlier cycle (mouse, then keyboard) already left behind -- a bare "does any notice/any
  // live-region text ever say this" check would pass on the OTHER cycle's own leftovers even if
  // THIS cycle's own toggle silently did nothing.
  const noticeCountBeforeActivate = (await allNoticeTexts(cdp)).length;
  await markLiveRegionSeen(cdp);

  if (mode === 'mouse') {
    await cdp.click(ADVISOR_CHIP_FINDER);
  } else {
    await clearComposer(cdp);
    await cdp.click(MESSAGE_FINDER);
    const reached = await tabToAdvisorChip(cdp, pressTab);
    if (!reached) {
      failures.push(`${tag} could not Tab to the Advisor chip within the step cap.`);
      return;
    }
    await pressEnterKey(cdp);
  }

  // Busy window: accessible name reads "Turning off…", and a second activation is a no-op
  // (the component's own `if (turningOff) return` guard -- asserted indirectly, by confirming
  // the name is still the busy wording immediately after the repeat activation, never reverted
  // or advanced early).
  await new Promise((resolve) => setTimeout(resolve, 50));
  const busyLabelBefore = await cdp.evaluate(`document.querySelector('[aria-label^="Advisor on. Turning off"]') ? 'busy' : 'not-busy'`);
  if (busyLabelBefore === 'busy') {
    findings.push(`${tag} busy accessible name "Advisor on. Turning off…" observed.`);
    if (mode === 'mouse') await cdp.click(ADVISOR_CHIP_FINDER).catch(() => {});
    else await pressEnterKey(cdp);
    const stillBusy = await cdp.evaluate(`document.querySelector('[aria-label^="Advisor on. Turning off"]') ? true : false`);
    if (!stillBusy) failures.push(`${tag} a repeat activation during the busy window did not stay in the busy state (expected a no-op).`);
    else findings.push(`${tag} a repeat activation during the busy window was a no-op, as expected.`);
  } else {
    findings.push(`${tag} the busy window closed before it could be observed (a fast real reply) -- not a failure, just too quick to catch.`);
  }

  try {
    await cdp.waitFor(`!(${ADVISOR_CHIP_FINDER})`, { timeoutMs: 30_000, label: `${tag} Advisor chip removed from the DOM/AX tree` });
    findings.push(`${tag} Advisor chip left the AX tree once the toggle settled.`);
  } catch (err) {
    failures.push(`${tag} ${err.message}`);
  }

  // Gate round 1 fix (High, item 13): sliced from `noticeCountBeforeActivate`, so a REAL leftover
  // "Advisor disabled." from an earlier cycle can never count toward THIS cycle's own result,
  // and exactly one (not merely "at least one") is required -- more than one would mean either a
  // duplicate send or an unexpected extra reply, neither of which is the expected shape.
  const noticesSinceActivate = (await allNoticeTexts(cdp)).slice(noticeCountBeforeActivate);
  const newDisabledNotices = noticesSinceActivate.filter((t) => /Advisor disabled\./.test(t));
  if (newDisabledNotices.length === 1) {
    findings.push(`${tag} exactly one NEW authoritative "Advisor disabled." reply confirmed (not a leftover from an earlier cycle).`);
  } else {
    failures.push(`${tag} expected exactly one NEW "Advisor disabled." notice since this cycle's own activation, found ${newDisabledNotices.length}.`);
  }

  // Gate round 1 fix (Critical, item 12): BOTH checked here, straight after the chip leaves the
  // AX tree -- BEFORE the supplementary `/advisor status` probe below, which itself clicks the
  // message box to type. Checking focus/the live region AFTER that probe could never fail
  // regardless of whether the real focus handoff worked at all.
  const focusOk = await activeElementIsMessageBox(cdp);
  if (focusOk) findings.push(`${tag} focus landed on the message textarea after the chip's own toggle-off.`);
  else failures.push(`${tag} focus did NOT land on the message textarea after the chip's own toggle-off.`);

  const announced = await waitForFreshLiveRegionText(cdp, 'Advisor off');
  if (announced) findings.push(`${tag} a NEW "Advisor off" announcement was observed in the composer's shared attachment live region.`);
  else failures.push(`${tag} no NEW "Advisor off" announcement was observed in the composer's shared attachment live region within the timeout.`);

  // Supplementary only (per `session::advisor`'s own documented ambiguity): logs the real
  // literal wording, never asserts it says "disabled" -- the authoritative check above already
  // covers the real pass/fail. Runs LAST (see the comment above): it clicks the message box
  // itself, so it must never run before the focus/live-region checks above.
  const statusReply = await sendSlashCommand(cdp, '/advisor status', /advisor/i).catch((err) => `<no reply: ${err.message}>`);
  findings.push(`${tag} supplementary "/advisor status" reply (wording not asserted, see this file's own header): ${JSON.stringify(statusReply)}`);

  await cdp.screenshot(path.join(shotsDir, `${mode}-cycle-after-toggle-off.png`));
}
