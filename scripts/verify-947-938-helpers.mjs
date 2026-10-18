// Helper functions for verify-947-938-slash-menu.mjs, split out solely to keep that script
// under the repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change from
// the original single-file version. See verify-947-938-slash-menu.mjs's own header comment for
// what this live check proves; this module holds the pure JS scorer port and CDP read/action
// helpers it drives through, not any of the actual assertions.

import { pressKey } from './verify-tauri-session-list-helpers.mjs';
import path from 'node:path';

// --- Pure JS port of src/shared/slashCommandSearch.ts, for an INDEPENDENT cross-check of the
// real app's rendered order -- not imported directly (that file is TypeScript; this script runs
// under plain Node), kept in lockstep with the source's own tier order and matching rules.
export const TIER_EXACT = 0;
export const TIER_PREFIX = 1;
export const TIER_WORD_START = 2;
export const TIER_SUBSTRING = 3;
export const TIER_SUBSEQUENCE = 4;
export const TIER_DESCRIPTION = 5;
export const WORD_BOUNDARY_CHARS = { '-': true, '_': true, ':': true, ' ': true };

export function scoreAgainstTarget(needle, target) {
  const lower = target.toLowerCase();
  if (lower === needle) return TIER_EXACT;
  if (lower.startsWith(needle)) return TIER_PREFIX;
  for (let i = 1; i + needle.length <= lower.length; i++) {
    if (!WORD_BOUNDARY_CHARS[lower[i - 1]]) continue;
    if (lower.slice(i, i + needle.length) === needle) return TIER_WORD_START;
  }
  if (lower.includes(needle)) return TIER_SUBSTRING;
  let targetIndex = 0;
  for (let i = 0; i < needle.length; i++) {
    const found = lower.indexOf(needle[i], targetIndex);
    if (found === -1) return null;
    targetIndex = found + 1;
  }
  return TIER_SUBSEQUENCE;
}

/** `commands`: `[{name, description}]` in Refract's own listed (input) order. Returns the same
 * shape ranked by `needle`, ties keeping input order -- matches `rankSlashCommands`'s own
 * contract exactly (description-only matches excluded here: this script only ever builds queries
 * that hit a NAME tier, so a real description-only hit would be a genuine, reportable surprise). */
export function rankCommandsJs(needle, commands) {
  const lowerNeedle = needle.toLowerCase();
  const scored = [];
  commands.forEach((command, index) => {
    const candidates = [command.name];
    if (command.name.toLowerCase().startsWith('skill:')) candidates.push(command.name.slice('skill:'.length));
    let best = null;
    for (const candidate of candidates) {
      const tier = scoreAgainstTarget(lowerNeedle, candidate);
      if (tier !== null && (best === null || tier < best)) best = tier;
    }
    if (best !== null) {
      scored.push({ command, tier: best, index });
      return;
    }
    // Decision 4 (gate round 1, H2): no name/alias match at all -- fall back to a flat
    // description-only tier (ranked below every name tier), but ONLY for a description match at
    // word-start or substring, never subsequence (a subsequence hit against a whole prose
    // sentence barely narrows anything), matching `matchCommand`'s own restricted fallback.
    const descTier = command.description ? scoreAgainstTarget(lowerNeedle, command.description) : null;
    if (descTier !== null && descTier <= TIER_SUBSTRING) {
      scored.push({ command, tier: TIER_DESCRIPTION, index });
    }
  });
  scored.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return scored.map((s) => s.command);
}

/** Finds one real command (and a needle) per requested tier, built algorithmically from
 * `commands` (never a hardcoded name) so this check works against whatever a real ambient OMP
 * install actually offers. Returns `{ prefix, wordStart, substring, subsequence }`, each either
 * `{ needle, name }` or `null` if this install's own command set has nothing suitable (a real,
 * reportable gap, not a script bug). */
/** The single best (lowest) NAME tier any command in `commands` achieves for `needle` (never
 * the description fallback, which is always worse than every name tier and so can never be the
 * tier that "beats" a candidate here) -- `null` when nothing matches by name at all. Used as a
 * guard: a tier's own test query is only valid once this confirms NO command scores a BETTER
 * tier than the one the query is meant to demonstrate, so the winner is provably on tier merit,
 * never by coincidence of which command this script happened to pick first. */
export function bestNameTier(needle, commands) {
  let best = null;
  for (const command of commands) {
    const candidates = [command.name];
    if (command.name.toLowerCase().startsWith('skill:')) candidates.push(command.name.slice('skill:'.length));
    for (const candidate of candidates) {
      const tier = scoreAgainstTarget(needle, candidate);
      if (tier !== null && (best === null || tier < best)) best = tier;
    }
  }
  return best;
}

/** Finds one real command (and a needle) per requested tier, built algorithmically from
 * `commands` (never a hardcoded name) so this check works against whatever a real ambient OMP
 * install actually offers -- and GUARDED by `bestNameTier` so each returned query is only kept
 * once confirmed that no OTHER real command in this same install scores a BETTER tier for that
 * needle (otherwise the "tier X wins" proof would be trivially defeated the moment some unrelated
 * command happens to prefix-match the same two letters). Returns `{ prefix, wordStart, substring,
 * subsequence }`, each either `{ needle, name }` or `null` if this install's own command set has
 * nothing that can demonstrate that tier cleanly (a real, reportable gap, not a script bug). */
export function buildTierQueries(commands) {
  const names = commands.map((c) => c.name);
  const result = { prefix: null, wordStart: null, substring: null, subsequence: null };

  for (const name of names) {
    if (result.prefix !== null || name.length < 2) continue;
    const needle = name.slice(0, 2).toLowerCase();
    if (bestNameTier(needle, commands) === TIER_PREFIX) result.prefix = { needle, name };
  }

  for (const name of names) {
    if (result.wordStart !== null) break;
    for (let i = 1; i + 2 <= name.length; i++) {
      if (!WORD_BOUNDARY_CHARS[name[i - 1]] || WORD_BOUNDARY_CHARS[name[i]]) continue;
      const needle = name.slice(i, i + 2).toLowerCase();
      if (bestNameTier(needle, commands) === TIER_WORD_START) {
        result.wordStart = { needle, name };
        break;
      }
    }
  }

  for (const name of names) {
    if (result.substring !== null || name.length < 4) continue;
    for (let mid = 1; mid + 2 <= name.length; mid++) {
      const needle = name.slice(mid, mid + 2).toLowerCase();
      if (bestNameTier(needle, commands) === TIER_SUBSTRING) {
        result.substring = { needle, name };
        break;
      }
    }
  }

  for (const name of names) {
    if (result.subsequence !== null || name.length < 5) continue;
    for (let dropAt = 1; dropAt < name.length - 1; dropAt++) {
      const needle = (name.slice(0, dropAt) + name.slice(dropAt + 1)).toLowerCase();
      if (bestNameTier(needle, commands) === TIER_SUBSEQUENCE) {
        result.subsequence = { needle, name };
        break;
      }
    }
  }

  return result;
}

/** Gate round 1 (H3): finds a needle where SOME command matches by name/alias (any tier) AND a
 * DIFFERENT command matches ONLY via its description, at word-start or substring (never
 * subsequence, the same H2 restriction `rankCommandsJs` now applies) -- proving decision 4
 * ("a description-only match always ranks below every name match") on a real, constructed case
 * instead of trusting it never happens to come up. `null` if this install's real command set has
 * no such needle. */
export function findDescriptionOnlyProbe(commands) {
  for (const candidate of commands) {
    if (!candidate.description) continue;
    const words = candidate.description.split(/[^a-zA-Z]+/).filter((w) => w.length >= 3);
    for (const word of words) {
      const needle = word.slice(0, 3).toLowerCase();
      if (bestNameTier(needle, commands) === null) continue; // need SOME other command to rank above
      const ownCandidates = [candidate.name];
      if (candidate.name.toLowerCase().startsWith('skill:')) ownCandidates.push(candidate.name.slice('skill:'.length));
      let ownNameTier = null;
      for (const own of ownCandidates) {
        const tier = scoreAgainstTarget(needle, own);
        if (tier !== null && (ownNameTier === null || tier < ownNameTier)) ownNameTier = tier;
      }
      if (ownNameTier !== null) continue; // this command ALSO matches by name -- not a clean probe
      const descTier = scoreAgainstTarget(needle, candidate.description);
      if (descTier === null || descTier > TIER_SUBSTRING) continue;
      return { needle, descriptionOnlyName: candidate.name };
    }
  }
  return null;
}

/** Gate round 1 (H3): finds a short needle guaranteed to match NOTHING in this install's real
 * command set at all -- no name, no alias, no description -- so the "No matching commands" empty
 * state can be asserted against a needle this script knows in advance cannot possibly match,
 * rather than trusting an arbitrary string happens to be unused. `null` if every candidate tried
 * happens to match something in this particular install. */
export function findNoMatchNeedle(commands) {
  // Gate round 1: three separate live "failures" ("/qxj", "/zqxj", then even this digit-based
  // "/9qxj7") all showed the caller's assertion as unmet. Root-caused, NOT an alias blind spot:
  // the caller's own selector (`verify-947-938-slash-menu.mjs`) used to read
  // `document.querySelector('[aria-hidden="true"]')` completely unscoped, which grabbed the
  // FIRST such element anywhere in the page -- in practice the composer's own unrelated
  // placeholder overlay div (`MessageInput.tsx` "Message the agent ... for commands ...
  // Markdown supported", also `aria-hidden="true"`), never the slash-menu's actual empty-state
  // div, regardless of what was typed. Fixed at the call site by scoping to
  // `div[aria-hidden="true"].bg-popover`, unique to the slash-menu's empty state (checked: no
  // other `aria-hidden="true"` element in this tree carries `bg-popover`). This needle generator
  // itself was never the problem, but digit-based needles remain strictly safer than letter-only
  // ones against a genuine hidden alias this script cannot see (aliases are never rendered in the
  // DOM, so `bestNameTier`'s guard above can only check `command.name` plus a skill's stripped
  // form) -- kept as belt-and-braces hardening, not because it fixed anything here.
  const candidates = ['9qxj7', '5vqz3', '8jqx2', '4xzq9', '7qzv1', '3wqx6', '2zjv8', '6kqx4', '1vjz5', '0xqz9'];
  for (const needle of candidates) {
    if (bestNameTier(needle, commands) !== null) continue;
    const anyDescriptionMatch = commands.some((c) => c.description && scoreAgainstTarget(needle, c.description) !== null);
    if (!anyDescriptionMatch) return needle;
  }
  return null;
}

// Same `NoticeRow` sr-only "Info:" icon-slot finder `verify-917-advisor-command.mjs` uses, for
// the same reasons (survives `react-virtuoso` windowing; two-parent climb reaches either the
// plain-div short-notice or the `CollapsibleTrigger`-button long-notice container).
export const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

export async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

export async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

// The turn-total-time line (`Transcript.tsx`'s `TurnTotalLine`, FR-046): found by its own
// sr-only "Turn took <N>" text, never by the bare visible "<N>" span alone (which this script
// would otherwise confuse with any other short muted text on the page). The LAST one in document
// order is the most recent turn's own line.
export const TURN_TOTAL_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] div')).filter((el) => (el.querySelector(':scope > span.sr-only')?.textContent ?? '').startsWith('Turn took'))`;

export async function readLatestTurnTotalText(cdp) {
  return cdp.evaluate(
    `(() => { const rows = (${TURN_TOTAL_FINDER}); const row = rows[rows.length - 1]; return row ? (row.querySelector(':scope > span[aria-hidden="true"]')?.textContent ?? null) : null; })()`
  );
}

/** Real Backspace keydown/keyup pairs, one per character currently in the composer (same
 * reasoning `verify-917-advisor-command.mjs`'s own `clearComposer` records). */
export async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await pressKey(cdp, 8, 'Backspace', 'Backspace');
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

export async function pressEnter(cdp) {
  await pressKey(cdp, 13, 'Enter', 'Enter');
}

export async function pressTab(cdp) {
  await pressKey(cdp, 9, 'Tab', 'Tab');
}

export async function pressEscape(cdp) {
  await pressKey(cdp, 27, 'Escape', 'Escape');
}

/** Reads whichever slash-menu listbox is mounted (top-level or a subcommand step share the same
 * markup): its own accessible name and each option row's name text, description, and whether (and
 * how heavily, via COMPUTED style -- not mere tag presence) its name is rendered bold. `null`
 * when no slash menu is mounted. */
export async function readSlashMenu(cdp) {
  return cdp.evaluate(
    `(() => {
      const list = document.querySelector('ul[aria-label="Slash commands"], ul[aria-label$=" subcommands"]');
      if (!list) return null;
      return {
        ariaLabel: list.getAttribute('aria-label'),
        options: Array.from(list.querySelectorAll('li[role="option"]')).map((li) => {
          const nameEl = li.querySelector('span.font-normal');
          const boldEl = nameEl?.querySelector('b') ?? null;
          const normalWeight = nameEl ? Number(getComputedStyle(nameEl).fontWeight) : null;
          const boldWeight = boldEl ? Number(getComputedStyle(boldEl).fontWeight) : null;
          return {
            name: (nameEl?.textContent ?? '').trim(),
            hasBold: !!boldEl,
            boldText: boldEl?.textContent ?? null,
            normalWeight,
            boldWeight,
            description: (li.querySelector('span.text-muted-foreground')?.textContent ?? '').trim()
          };
        })
      };
    })()`
  );
}

// The slash menu's OWN politely-announced live region (round 2 gate finding M1/L4). Live-check
// FAILURE FOUND AND FIXED: the first live run's own `.find((el) => !el.id)` (with no tag
// restriction) grabbed Transcript.tsx's own always-mounted `<span role="status" aria-live=
// "polite">` region instead (`revealedAnnouncement`/`stageAnnouncement`, also id-less) --
// Transcript renders BEFORE MessageInput in ChatPane.tsx's own JSX, so its spans always come
// first in document order, and that text never once changes to "No matching subcommands" no
// matter how long the wait. Root-caused via static DOM/JSX-order analysis (a script bug, NOT a
// product one -- the separate on-screen "No matching subcommands" check independently proved the
// product behaviour correct). Scoped to the `div` tag: the slash announcement is a `<div>`;
// MessageInput's other two such regions (attachments, ghost-text) are also `<div>`s but both
// carry their own `id`, so `!el.id` alone still tells this one apart from them.
export const SLASH_ANNOUNCEMENT_FINDER = `Array.from(document.querySelectorAll('div[role="status"][aria-live="polite"]')).find((el) => !el.id)`;

/** The whole subcommand-step live-check sequence (#938 item 1, FR-073/FR-074, plus round 2 gate
 * findings H and M1): split out of verify-947-938-slash-menu.mjs solely to keep that script under
 * the repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change from the
 * inline version. Mutates the caller's own `findings`/`failures`/`notExercised` arrays in place
 * (the same accumulation pattern the main script's own top-level checks use). Assumes `/advisor`
 * is a real command on this install with verified subcommands (on/off/status) -- the caller is
 * responsible for having already cleared the composer before calling this. */
export async function runSubcommandStepChecks(cdp, { SHOTS_DIR, findings, failures, notExercised }) {
  // ---- (2) Choosing "/advisor" does not send it; the menu advances to a second step naming
  // "/advisor subcommands", its own first row always "Run /advisor" (M4, decided 2026-10-18),
  // "status" the first REAL subcommand right after it ----
  await cdp.send('Input.insertText', { text: '/advisor' });
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"] span.font-normal')).find((el) => el.textContent.trim() === '/advisor')`,
    { timeoutMs: 15_000, label: 'Slash menu lists "/advisor"' }
  );
  await pressEnter(cdp); // selects /advisor -- should NOT send; should advance to its subcommand step
  const afterParentSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
    timeoutMs: 10_000,
    label: 'Composer value settles after selecting "/advisor"'
  });
  if (afterParentSelect !== '/advisor ') {
    failures.push(`Selecting "/advisor" left the composer reading "${afterParentSelect}", not "/advisor " -- it may have sent immediately instead of advancing to the subcommand step.`);
  }
  let subMenu = null;
  try {
    await cdp.waitFor(`!!document.querySelector('ul[aria-label$=" subcommands"]')`, { timeoutMs: 10_000, label: 'Subcommand step menu mounted' });
    subMenu = await readSlashMenu(cdp);
  } catch {
    failures.push('The subcommand step menu never mounted after selecting "/advisor".');
  }
  if (subMenu && subMenu.ariaLabel !== '/advisor subcommands') {
    failures.push(`Expected the subcommand step's own accessible name "/advisor subcommands"; got ${JSON.stringify(subMenu.ariaLabel)}.`);
  } else if (subMenu) {
    findings.push(`Subcommand step mounted with accessible name "${subMenu.ariaLabel}".`);
  }
  if (subMenu && subMenu.options[0]?.name !== 'Run /advisor') {
    failures.push(`Expected "Run /advisor" first in the untyped subcommand step (M4); got ${JSON.stringify(subMenu.options.map((o) => o.name))}.`);
  } else if (subMenu && subMenu.options[1]?.name !== 'status') {
    failures.push(`Expected "status" right after "Run /advisor" in the untyped subcommand step; got ${JSON.stringify(subMenu.options.map((o) => o.name))}.`);
  } else if (subMenu) {
    findings.push(`Subcommand step lists "Run /advisor" first, then "status" (options: ${JSON.stringify(subMenu.options.map((o) => o.name))}).`);
  }
  await cdp.screenshot(path.join(SHOTS_DIR, '02-subcommand-step.png'));
  if (!subMenu) {
    notExercised.push('Selecting a subcommand was not exercised -- the subcommand step menu never mounted (see the failure above).');
    return;
  }
  // ---- (2a) M4: the default-active "Run /advisor" row sends the bare command at once ----
  const beforeRunBareNotices = await countNotices(cdp);
  await pressEnter(cdp); // selects "Run /advisor" (default active row) -- should SEND at once
  try {
    await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 10_000, label: 'Composer cleared after "Run /advisor"' });
    findings.push('Selecting "Run /advisor" (the subcommand step\'s own default-active first row) sent the bare command at once -- the composer cleared, matching a real send.');
  } catch {
    failures.push('Selecting "Run /advisor" left the composer non-empty -- it did not send at once (M4 regression).');
  }
  // Confirm it actually reached OMP as a real command (a reply notice), not merely a cleared
  // composer with nothing sent.
  const deadlineRunBare = Date.now() + 15_000;
  let runBareReplied = false;
  while (Date.now() < deadlineRunBare) {
    if ((await countNotices(cdp)) > beforeRunBareNotices) {
      runBareReplied = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!runBareReplied) {
    notExercised.push('"Run /advisor" was selected but no new notice appeared within 15s -- could not confirm a real send reached OMP.');
  } else {
    findings.push('"Run /advisor" produced a new notice -- confirmed as a real send, not just a cleared composer.');
  }
  await cdp.screenshot(path.join(SHOTS_DIR, '02a-run-bare-sends.png'));

  // ---- (2b) A typed, EXACT subcommand match completes on Tab without sending ----
  await clearComposer(cdp);
  await cdp.send('Input.insertText', { text: '/advisor status' });
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === '/advisor status'`, {
    timeoutMs: 10_000,
    label: 'Composer reads "/advisor status" before Tab'
  });
  await pressTab(cdp);
  const afterSubSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
    timeoutMs: 10_000,
    label: 'Composer value settles after Tab on "status"'
  });
  if (afterSubSelect !== '/advisor status ') {
    failures.push(`Tab on a typed exact subcommand match left the composer reading "${afterSubSelect}", not "/advisor status " -- Tab must still only complete, never send (M4).`);
  } else {
    findings.push('Tab on a typed exact subcommand match ("status") completed the composer to "/advisor status " without sending -- M4\'s "Tab still completes" rule confirmed.');
  }
  await cdp.screenshot(path.join(SHOTS_DIR, '03-subcommand-completed.png'));

  // ---- (2c) Round 2 gate finding H: a PARTLY typed subcommand query ("sta", a prefix match for
  // "status", not an exact one) must rank "status" first (the synthetic "Run /advisor" row only
  // ever shows on an EMPTY query) and Enter must complete to it, never blind-send the bare
  // command just because the highlight defaulted to index 0 ----
  await clearComposer(cdp);
  await cdp.send('Input.insertText', { text: '/advisor sta' });
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === '/advisor sta'`, {
    timeoutMs: 10_000,
    label: 'Composer reads "/advisor sta" before Enter'
  });
  await cdp.waitFor(`!!document.querySelector('ul[aria-label="/advisor subcommands"] li[role="option"]')`, {
    timeoutMs: 10_000,
    label: 'Subcommand step menu mounted for "/advisor sta"'
  });
  const partialSubMenu = await readSlashMenu(cdp);
  const partialSubOptions = (partialSubMenu?.options ?? []).map((o) => o.name);
  if (partialSubOptions[0] === 'Run /advisor') {
    failures.push(`"/advisor sta" still lists "Run /advisor" in the menu (options: ${JSON.stringify(partialSubOptions)}) -- the run-bare row must disappear once the subcommand query is non-empty (H).`);
  } else if (partialSubOptions[0] !== 'status') {
    failures.push(`"/advisor sta" ranked "${partialSubOptions[0]}" first, not "status" (options: ${JSON.stringify(partialSubOptions)}).`);
  } else {
    findings.push(`"/advisor sta": the run-bare row is gone and "status" ranks first (options: ${JSON.stringify(partialSubOptions)}) -- H fix confirmed.`);
  }
  const beforePartialNotices = await countNotices(cdp);
  await pressEnter(cdp);
  const afterPartialSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
    timeoutMs: 10_000,
    label: 'Composer value settles after Enter on "/advisor sta"'
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // real wall-clock gap: a wrongly-sent bare command would show a new notice within this window
  const afterPartialNotices = await countNotices(cdp);
  if (afterPartialSelect !== '/advisor status ') {
    failures.push(`Enter on the partly typed "/advisor sta" left the composer reading "${afterPartialSelect}", not "/advisor status " (H).`);
  } else if (afterPartialNotices > beforePartialNotices) {
    failures.push('Enter on the partly typed "/advisor sta" completed the composer correctly but ALSO produced a new notice -- it blind-sent the bare command as well as completing (H regression).');
  } else {
    findings.push('"/advisor sta" + Enter completed the composer to "/advisor status " without sending anything -- H fix confirmed (a partly typed subcommand never blind-fires the bare command).');
  }
  await cdp.screenshot(path.join(SHOTS_DIR, '03b-partial-subcommand-completed.png'));

  // ---- (2d) M1: a non-empty query with no matching subcommand shows "No matching subcommands"
  // ON SCREEN (matching what a screen reader hears via the debounced announcement), not just
  // silently to assistive tech -- "zzz" cannot subsequence-match any of advisor's real
  // subcommands (on/off/status: none contain a "z" at all) ----
  await clearComposer(cdp);
  await cdp.send('Input.insertText', { text: '/advisor zzz' });
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === '/advisor zzz'`, {
    timeoutMs: 10_000,
    label: 'Composer reads "/advisor zzz"'
  });
  try {
    await cdp.waitFor(`document.querySelector('div[aria-hidden="true"].bg-popover')?.textContent?.trim() === 'No matching subcommands'`, {
      timeoutMs: 10_000,
      label: '"No matching subcommands" shown on screen for "/advisor zzz"'
    });
    findings.push('"/advisor zzz" (no real subcommand can match) correctly shows "No matching subcommands" ON SCREEN (M1).');
  } catch {
    failures.push('"/advisor zzz" did not show "No matching subcommands" on screen (M1).');
  }
  try {
    await cdp.waitFor(`(${SLASH_ANNOUNCEMENT_FINDER})?.textContent?.trim() === 'No matching subcommands'`, {
      timeoutMs: 10_000,
      label: 'Announcement reads "No matching subcommands" for "/advisor zzz" (debounced 500ms)'
    });
    findings.push('"/advisor zzz" announced "No matching subcommands" via the live region -- matches what is shown on screen (M1).');
  } catch {
    failures.push('"/advisor zzz" never announced "No matching subcommands" via the live region, even though the on-screen text (if shown) says it (M1).');
  }
  await cdp.screenshot(path.join(SHOTS_DIR, '03c-no-matching-subcommands.png'));
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('ul[aria-label$=" subcommands"], div[aria-hidden="true"].bg-popover')`, {
    timeoutMs: 5_000,
    label: 'Menu closed after Escape'
  });
  findings.push('Escape closed the subcommand step (both the listbox and the "No matching subcommands" empty state are gone).');
}
