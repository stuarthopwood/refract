// Helper functions for verify-947-938-slash-menu.mjs, split out solely to keep that script
// under the repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change from
// the original single-file version. See verify-947-938-slash-menu.mjs's own header comment for
// what this live check proves; this module holds the pure JS scorer port and CDP read/action
// helpers it drives through, not any of the actual assertions.

import { pressKey } from './verify-tauri-session-list-helpers.mjs';

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
