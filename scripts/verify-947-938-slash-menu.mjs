#!/usr/bin/env node
// Live CDP check for issues #947 (fuzzy slash-command search) and #938 items 1 and 4 (slash
// subcommand step; a command reply no longer stretching the previous turn's own shown time),
// required before the draft PR. Modelled on `verify-917-advisor-command.mjs`'s own structure and
// isolation posture.
//
// Drives a REAL `omp` (ambient already-signed-in default profile; no scratch OMP_PROFILE
// override -- only Refract's OWN data, `REFRACT_DATA_DIR`, is scratch). Checks, in order:
// (0) typing a bare `/` lists every command Refract offers (FR-032, FR-072's own "An empty query
// matches every command" rule) -- asserted against the two commands Refract ALWAYS lists itself
// (`new`, `btw`), not a hardcoded total, since the real ambient install's own command set is not
// under this script's control; (1) fuzzy ranking order (FR-072): queries are built
// ALGORITHMICALLY from whatever commands this real install actually offers (never hardcoded
// names), one per tier this scorer recognises (prefix, word-start, substring, subsequence), and
// the full rendered order is asserted against an independent JS port of
// `src/shared/slashCommandSearch.ts`'s own algorithm run over the SAME real command list; the
// winning query's own top match is also asserted to carry a `<b>` span whose COMPUTED font-weight
// actually outweighs the surrounding plain text (not just tag presence); (1b) a `skill:<name>`
// entry matches with or without the `skill:` prefix, if this install offers any (genuine
// `notExercised` otherwise, never faked); (2) the subcommand step -- selecting `/advisor` leaves
// the composer reading `/advisor ` instead of sending, the menu's own accessible name becomes
// "/advisor subcommands", and its first row is `status` with nothing typed yet (FR-073);
// selecting that subcommand completes `/advisor status ` without sending; (3) a real turn's own
// total-time line (the "`Turn took <N>`" sr-only text) does not change after a command reply
// (`/advisor status`, this story's #938 item 4 fix) arrives once that turn has already settled --
// asserted by reading the SAME line's text before and after the command, not merely that the
// command's own reply arrived.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-947-938';
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_947_938_SHOTS_DIR || path.join(tmpdir(), 'refract-947-938-slash-menu-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;

// --- Pure JS port of src/shared/slashCommandSearch.ts, for an INDEPENDENT cross-check of the
// real app's rendered order -- not imported directly (that file is TypeScript; this script runs
// under plain Node), kept in lockstep with the source's own tier order and matching rules.
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_WORD_START = 2;
const TIER_SUBSTRING = 3;
const TIER_SUBSEQUENCE = 4;
const WORD_BOUNDARY_CHARS = { '-': true, '_': true, ':': true, ' ': true };

function scoreAgainstTarget(needle, target) {
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
function rankCommandsJs(needle, commands) {
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
    if (best !== null) scored.push({ command, tier: best, index });
  });
  scored.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return scored.map((s) => s.command);
}

/** Finds one real command (and a needle) per requested tier, built algorithmically from
 * `commands` (never a hardcoded name) so this check works against whatever a real ambient OMP
 * install actually offers. Returns `{ prefix, wordStart, substring, subsequence }`, each either
 * `{ needle, name }` or `null` if this install's own command set has nothing suitable (a real,
 * reportable gap, not a script bug). */
function buildTierQueries(commands) {
  const names = commands.map((c) => c.name);
  const result = { prefix: null, wordStart: null, substring: null, subsequence: null };
  for (const name of names) {
    if (result.prefix === null && name.length >= 2) {
      result.prefix = { needle: name.slice(0, 2), name };
    }
    if (result.wordStart === null) {
      for (let i = 1; i < name.length - 1; i++) {
        if (WORD_BOUNDARY_CHARS[name[i - 1]] && !WORD_BOUNDARY_CHARS[name[i]]) {
          result.wordStart = { needle: name.slice(i, i + 2), name };
          break;
        }
      }
    }
    if (result.substring === null && name.length >= 4) {
      // A middle 2-char slice that is neither the prefix nor (per the scan above) right after a
      // word boundary, so this scorer's own earlier tiers cannot claim it first.
      const mid = Math.floor(name.length / 2);
      const slice = name.slice(mid, mid + 2);
      if (!name.toLowerCase().startsWith(slice.toLowerCase()) && slice.length === 2) {
        result.substring = { needle: slice, name };
      }
    }
    if (result.subsequence === null && name.length >= 5) {
      // Drop one interior character so the needle can never be a contiguous substring, but is
      // always a valid left-to-right subsequence of `name` itself.
      const dropAt = Math.floor(name.length / 2);
      const needle = name.slice(0, dropAt) + name.slice(dropAt + 1);
      if (!name.toLowerCase().includes(needle.toLowerCase())) {
        result.subsequence = { needle, name };
      }
    }
  }
  return result;
}

// Same `NoticeRow` sr-only "Info:" icon-slot finder `verify-917-advisor-command.mjs` uses, for
// the same reasons (survives `react-virtuoso` windowing; two-parent climb reaches either the
// plain-div short-notice or the `CollapsibleTrigger`-button long-notice container).
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

// The turn-total-time line (`Transcript.tsx`'s `TurnTotalLine`, FR-046): found by its own
// sr-only "Turn took <N>" text, never by the bare visible "<N>" span alone (which this script
// would otherwise confuse with any other short muted text on the page). The LAST one in document
// order is the most recent turn's own line.
const TURN_TOTAL_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] div')).filter((el) => (el.querySelector(':scope > span.sr-only')?.textContent ?? '').startsWith('Turn took'))`;

async function readLatestTurnTotalText(cdp) {
  return cdp.evaluate(
    `(() => { const rows = (${TURN_TOTAL_FINDER}); const row = rows[rows.length - 1]; return row ? (row.querySelector(':scope > span[aria-hidden="true"]')?.textContent ?? null) : null; })()`
  );
}

/** Real Backspace keydown/keyup pairs, one per character currently in the composer (same
 * reasoning `verify-917-advisor-command.mjs`'s own `clearComposer` records). */
async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await pressKey(cdp, 8, 'Backspace', 'Backspace');
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

async function pressEnter(cdp) {
  await pressKey(cdp, 13, 'Enter', 'Enter');
}

/** Reads whichever slash-menu listbox is mounted (top-level or a subcommand step share the same
 * markup): its own accessible name and each option row's name text, description, and whether (and
 * how heavily, via COMPUTED style -- not mere tag presence) its name is rendered bold. `null`
 * when no slash menu is mounted. */
async function readSlashMenu(cdp) {
  return cdp.evaluate(
    `(() => {
      const list = document.querySelector('ul[aria-label="Slash commands"], ul[aria-label$=" subcommands"]');
      if (!list) return null;
      return {
        ariaLabel: list.getAttribute('aria-label'),
        options: Array.from(list.querySelectorAll('li[role="option"]')).map((li) => {
          const nameEl = li.querySelector('span.font-medium');
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

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-947-938-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-947-938-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-947-938-repo-')), 'verify-947-938-slash-menu');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-947-938-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-947-938-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`${LOG}: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`${LOG}: data dir ${dataDir}`);
    console.log(`${LOG}: shots dir ${SHOTS_DIR}`);
    console.log(`${LOG}: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // ---- (0) Bare "/" lists every command (FR-032, FR-072 "empty query matches every command")
    // ---- also the one place this script reads the REAL command list, which every later section
    // reuses to build its own queries, rather than a hardcoded name.
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: '/' });
    await cdp.waitFor(`!!document.querySelector('ul[aria-label="Slash commands"]')`, { timeoutMs: 15_000, label: 'Slash menu mounted for bare "/"' });
    const bareMenu = await readSlashMenu(cdp);
    const realCommands = (bareMenu?.options ?? []).map((o) => ({ name: o.name, description: o.description }));
    const names = new Set(realCommands.map((c) => c.name));
    if (realCommands.length < 2 || !names.has('new') || !names.has('btw')) {
      failures.push(
        `Bare "/" listed ${realCommands.length} command(s), missing one of Refract's own always-present native commands (new, btw): ${JSON.stringify([...names])}.`
      );
    } else {
      findings.push(`Bare "/" lists ${realCommands.length} commands (includes both always-present native commands "new" and "btw").`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-bare-slash-lists-every-command.png'));

    // ---- (1) Fuzzy ranking order (#947, FR-072): queries built algorithmically from the REAL
    // command list above, one per tier (prefix, word-start, substring, subsequence), each
    // asserted against an independent JS port of the real scorer, not a hardcoded expectation ----
    const tierQueries = buildTierQueries(realCommands);
    for (const [tierName, query] of Object.entries(tierQueries)) {
      if (!query) {
        notExercised.push(`No real command in this install's own list supports a "${tierName}"-tier query -- that tier was not exercised.`);
        continue;
      }
      await clearComposer(cdp);
      await cdp.send('Input.insertText', { text: `/${query.needle}` });
      try {
        await cdp.waitFor(`!!document.querySelector('ul[aria-label="Slash commands"] li[role="option"]')`, {
          timeoutMs: 15_000,
          label: `Slash menu mounted for "${tierName}" query "/${query.needle}"`
        });
      } catch {
        failures.push(`Typing "/${query.needle}" (built for the "${tierName}" tier, expected to surface "${query.name}") never mounted the slash menu.`);
        continue;
      }
      const rendered = await readSlashMenu(cdp);
      const expectedOrder = rankCommandsJs(query.needle, realCommands).map((c) => c.name);
      const renderedOrder = (rendered?.options ?? []).map((o) => o.name);
      if (JSON.stringify(renderedOrder) !== JSON.stringify(expectedOrder)) {
        failures.push(
          `"${tierName}" tier query "/${query.needle}": rendered order ${JSON.stringify(renderedOrder)} does not match the independently computed expected order ${JSON.stringify(expectedOrder)} (built to surface "${query.name}").`
        );
      } else {
        findings.push(
          `"${tierName}" tier query "/${query.needle}" (built against real command "${query.name}"): rendered order exactly matches the independently computed ranking -- ${JSON.stringify(renderedOrder)}.`
        );
      }
      // Computed-font-weight bold check on the TOP (best-ranked) option's own name span, for the
      // tier whose match is a genuine NAME hit (every tier query here is, by construction).
      const top = rendered?.options?.[0];
      if (!top || !top.hasBold || top.boldWeight == null || top.normalWeight == null) {
        failures.push(`"${tierName}" tier query "/${query.needle}": top option "${top?.name}" has no bolded match span (or its computed weight could not be read) -- FR-072 decision 5.`);
      } else if (!(top.boldWeight > top.normalWeight)) {
        failures.push(
          `"${tierName}" tier query "/${query.needle}": top option "${top.name}"'s matched span computed font-weight (${top.boldWeight}) is not heavier than the surrounding plain text (${top.normalWeight}) -- bold is not actually rendered bold.`
        );
      } else {
        findings.push(
          `"${tierName}" tier query "/${query.needle}": top option "${top.name}"'s matched span "${top.boldText}" computed font-weight ${top.boldWeight} > surrounding ${top.normalWeight} (genuinely bold, not just tagged).`
        );
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-fuzzy-tier-ordering.png'));
    await clearComposer(cdp);

    // ---- (1b) A skill:<name> entry matches with or without the "skill:" prefix (FR-072 decision
    // 2) -- only if this real ambient install actually offers one; a genuine environment gap is
    // reported as notExercised, never faked ----
    const skillCommands = realCommands.filter((c) => c.name.toLowerCase().startsWith('skill:'));
    if (skillCommands.length === 0) {
      notExercised.push('This real ambient omp install offers no skill:<name> commands -- the skill-prefix-optional match (FR-072 decision 2) was not exercised.');
    } else {
      const skill = skillCommands[0];
      const bareName = skill.name.slice('skill:'.length);
      const needle = bareName.slice(0, Math.min(3, bareName.length));
      await cdp.send('Input.insertText', { text: `/${needle}` });
      try {
        await cdp.waitFor(
          `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"] span.font-medium')).find((el) => el.textContent.trim() === ${JSON.stringify(skill.name)})`,
          { timeoutMs: 15_000, label: `Slash menu lists "${skill.name}" for query "/${needle}" (no "skill:" typed)` }
        );
        findings.push(`"/${needle}" (no "skill:" typed) listed "${skill.name}" -- a skill matches on its bare name.`);
      } catch {
        failures.push(`Typing "/${needle}" (the bare prefix of "${skill.name}" with no "skill:" typed) never listed it -- the skill-prefix-optional match does not appear to run.`);
      }
      await clearComposer(cdp);
      await cdp.send('Input.insertText', { text: '/skill' });
      await cdp.waitFor(`!!document.querySelector('ul[aria-label="Slash commands"] li[role="option"]')`, { timeoutMs: 15_000, label: 'Slash menu lists for "/skill"' });
      const skillMenu = await readSlashMenu(cdp);
      const listedSkillCount = (skillMenu?.options ?? []).filter((o) => o.name.toLowerCase().startsWith('skill:')).length;
      if (listedSkillCount < skillCommands.length) {
        failures.push(`"/skill" listed only ${listedSkillCount} of this install's ${skillCommands.length} skill:<name> commands.`);
      } else {
        findings.push(`"/skill" lists all ${listedSkillCount} skill:<name> commands via an ordinary prefix match on the full "skill:" name.`);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '01b-skill-prefix-optional.png'));
    }
    await clearComposer(cdp);

    // ---- (2) Subcommand step (#938 item 1, FR-073): choosing "/advisor" does not send it; the
    // menu advances to a second step naming "/advisor subcommands", "status" first ----
    await cdp.send('Input.insertText', { text: '/advisor' });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"] span.font-medium')).find((el) => el.textContent.trim() === '/advisor')`,
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
    if (subMenu && subMenu.options[0]?.name !== 'status') {
      failures.push(`Expected "status" first in the untyped subcommand step; got ${JSON.stringify(subMenu.options.map((o) => o.name))}.`);
    } else if (subMenu) {
      findings.push(`Subcommand step lists "status" first (options: ${JSON.stringify(subMenu.options.map((o) => o.name))}).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-subcommand-step.png'));
    if (subMenu) {
      await pressEnter(cdp); // selects "status" (first row) -- should complete the text, not send
      const afterSubSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
        timeoutMs: 10_000,
        label: 'Composer value settles after selecting "status"'
      });
      if (afterSubSelect !== '/advisor status ') {
        failures.push(`Selecting "status" left the composer reading "${afterSubSelect}", not "/advisor status ".`);
      } else {
        findings.push('Selecting "status" completed the composer to "/advisor status " without sending -- the subcommand step\'s own Enter only completes text, exactly like the top-level step.');
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '03-subcommand-completed.png'));
    } else {
      notExercised.push('Selecting a subcommand was not exercised -- the subcommand step menu never mounted (see the failure above).');
    }

    // ---- (3) A real turn, then a command reply that must NOT stretch its own turn-total-time
    // line (#938 item 4, amended FR-046) ----
    await clearComposer(cdp);
    await cdp.typeIntoByLabel('Message', "Reply with exactly the single word 't947turn' and nothing else.");
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = (${TRANSCRIPT}); return !!t && (t.textContent.match(/t947turn/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (t947turn) finished (assistant echoed the sentinel back)' }
    );
    let elapsedBefore = null;
    try {
      await cdp.waitFor(`(${TURN_TOTAL_FINDER}).length > 0`, { timeoutMs: 30_000, label: 'Turn-total-time line mounted' });
      elapsedBefore = await readLatestTurnTotalText(cdp);
    } catch {
      // fall through: handled by the null check below
    }
    if (!elapsedBefore) {
      notExercised.push('No turn-total-time line was found after the sentinel turn settled -- the live-time-stretch check below could not run.');
    } else {
      findings.push(`Turn-total-time line reads "${elapsedBefore}" right after the sentinel turn settled.`);
      await cdp.screenshot(path.join(SHOTS_DIR, '04-turn-settled.png'));
      await new Promise((resolve) => setTimeout(resolve, 3_000)); // real wall-clock gap before the command reply, so a bug WOULD visibly grow the line
      const before = await countNotices(cdp);
      await clearComposer(cdp);
      await cdp.typeIntoByLabel('Message', '/advisor status');
      await cdp.clickByLabel('Send message');
      const deadline = Date.now() + 30_000;
      let replyText = null;
      while (Date.now() < deadline) {
        const texts = await allNoticeTexts(cdp);
        const match = texts.slice(before).find((t) => /advisor/i.test(t));
        if (match) {
          replyText = match;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!replyText) {
        notExercised.push('"/advisor status" produced no notice within 30s after the settled turn -- the time-stretch check could not confirm a reply actually arrived.');
      } else {
        findings.push(`"/advisor status" (sent after the turn settled) produced: ${JSON.stringify(replyText)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // settle time for computeTurnEnd's own re-commit
      const elapsedAfter = await readLatestTurnTotalText(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, '05-after-command-reply.png'));
      if (elapsedAfter !== elapsedBefore) {
        failures.push(`Turn-total-time line changed from "${elapsedBefore}" to "${elapsedAfter}" after the command reply -- the reply is still stretching the previous turn's own shown time.`);
      } else {
        findings.push(`Turn-total-time line is UNCHANGED ("${elapsedAfter}") after the command reply -- the reply no longer stretches the turn's own shown time.`);
      }
    }

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${LOG}: ${failures.length > 0 ? 'FAILED' : notExercised.length > 0 ? 'DONE (some ACs not exercised, see above)' : 'DONE'}.`);
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
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
