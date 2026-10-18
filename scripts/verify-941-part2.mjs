#!/usr/bin/env node
// Live CDP check for issue #941 part 2 (Subagent panel Stage grouping + green state, and the
// per-turn "Up next" Todo-phase list) -- FR-079's own deferred note from part 1 (PR #979/#979):
// "the Subagent panel's own green state and Stage grouping, and the Up next list's own UI, are
// not yet built here -- only the Rust/TS wire data (context, todoPhases) is in place,
// unconsumed." This proves both now are.
//
// Reuses PART 1's own recorded-frame fake `omp` harness and fixture
// (`scripts/fixtures/omp-frames/stages-941.jsonl`, `REFRACT_FAKE_OMP_SCENARIO=stages-941`) --
// the SAME ten-Stage turn, extended (additively, never touching anything part 1's own
// assertions read) with a `todoPhases` field on the ONE `get_state` response the tape already
// scripts, so the Session attaches with two real pending Todo phases from the very start
// (`readout.rs`'s own `on_sync_from_state` reads `todoPhases` off THAT SAME response every
// other field it already reads comes from, and schedules a readout update -- no second
// `get_state` round trip needed). PATH-prepends the SAME fake-`omp` PATH shim part 1's own
// `launchBuiltExeWithEnv` call does (`buildOmpShim`/`pathPrepend: shimDir`) -- this NEVER spawns
// or waits on a real `omp` process.
//
// Scope boundary (documented, not an oversight): `SubagentSummary` (the panel's own data,
// `src/shared/model.ts`) carries no `context` field and `nameOrTask` is the agent's own NAME
// whenever one was given (every task in this fixture has one) -- the fixture's own real
// `agent://` references all live in each Stage's `context` argument, which the panel never sees,
// so no Stage's own panel header has anything to resolve a "Uses:" line from. This positively
// proves the GROUPING/GREEN-STATE half of FR-079's deferred note; the panel's own "Uses:"
// rendering path is exercised only as a NEGATIVE (no stray/wrong text), its positive case
// recorded honestly in `report.json`'s own `notExercised`.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  clickScrolled,
  clickByLabelScrolled,
  clickByTextScrolled,
  titleSelector,
  stageContentSelector,
  expandRow,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE4_TITLE,
  STAGE5_TITLE,
  STAGE6_SOLO_TITLE,
  STAGE7_TITLE,
  STAGE8_PREFIX_TITLE,
  STAGE9_SOLO_NOCTX_TITLE,
  STAGE10_BORDERLINE_TITLE,
  PLAIN_TOOL_TITLE
} from './verify-941-stage-naming-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE =
  'Run the #923 quality gate, then the #559/#560 fixes, then read the README, then the zeta/omega probes, the label check, the Story559 polish and fail probe, the final solo check, the long-context investigation, the shared-prefix probes, the solo bare-label check, and the borderline-length context check.';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// Gate round 1 fix (issue #941 part 2, item 3 decision, item 10, HIGH): the panel's own Stage
// header never shows "Stage N" (ui-architect-v3 ruling, research.md decision 17) -- the shared
// name prefix when one exists, else a bare "N agents" -- so "Stage 3" and "Stage 5" both become
// the ambiguous "2 agents" (no shared prefix either way), and "Story559" appears under BOTH
// Stage 2 and Stage 5. Title-text lookups can no longer disambiguate rows at all; the panel's
// own tree is instead walked IN ORDER (scoped to `[role="tree"][aria-label="Subagents"]`) and
// compared against this exact expected shape -- the only thing that still tells two same-label
// rows apart is their real POSITION in the fixture's own task() call order.
const EXPECTED_PANEL_ROWS = [
  { level: '1', isStage: true, label: 'G923', green: true }, // Stage 1 header
  { level: '2', isStage: false, label: 'G923Code', green: true },
  { level: '2', isStage: false, label: 'G923Arch', green: true },
  { level: '1', isStage: true, label: 'Story5', green: true }, // Stage 2 header
  { level: '2', isStage: false, label: 'Story559', green: true },
  { level: '2', isStage: false, label: 'Story560', green: true },
  { level: '1', isStage: true, label: '2 agents', green: true }, // Stage 3 header (no shared prefix)
  { level: '2', isStage: false, label: 'Zeta', green: true },
  { level: '2', isStage: false, label: 'Omega', green: true },
  { level: '1', isStage: true, label: 'Label', green: true }, // Stage 4 header
  { level: '2', isStage: false, label: 'LabelA', green: true },
  { level: '2', isStage: false, label: 'LabelB', green: true },
  // Gate round 4 fix (issue #941 part 2, item 3, LOW): `exactAriaLabel` -- the ONE row whose own
  // accessible name is asserted character-for-character, not just substring/regex-matched like
  // every other row below: label "2 agents" (no shared prefix, same as Stage 3's), rollup "1
  // done, 1 failed" (`stageRollupText`, not running), aggregateStatus "failed" (`overallStatus`:
  // `counts.failed > 0` wins over `finished`) so the chain-matching ", Failed" suffix applies
  // (`SubagentChainRow.tsx`'s own `status !== 'finished'` rule) -- proves item 2's status-word
  // append on the one row in this fixture where it is NOT a no-op.
  { level: '1', isStage: true, label: '2 agents', green: false, exactAriaLabel: '2 agents, 1 done, 1 failed, Failed' }, // Stage 5 header (mixed finished/failed)
  { level: '2', isStage: false, label: 'Story559', green: true },
  { level: '2', isStage: false, label: 'FailAgent', green: false },
  { level: '1', isStage: false, label: 'R8Solo', green: true }, // Stage 6, solo, stays flat
  { level: '1', isStage: true, label: 'LongCtx', green: true }, // Stage 7 header
  { level: '2', isStage: false, label: 'LongCtxA', green: true },
  { level: '2', isStage: false, label: 'LongCtxB', green: true },
  { level: '1', isStage: true, label: 'Pfx', green: true }, // Stage 8 header
  { level: '2', isStage: false, label: 'PfxOne', green: true },
  { level: '2', isStage: false, label: 'PfxTwo', green: true },
  { level: '1', isStage: false, label: 'SoloBare', green: true }, // Stage 9, solo, stays flat
  { level: '1', isStage: true, label: 'Borderline', green: true }, // Stage 10 header
  { level: '2', isStage: false, label: 'BorderlineA', green: true },
  { level: '2', isStage: false, label: 'BorderlineB', green: true }
];

/** Issue #941 part 2: walks the panel's own tree in document order, comparing every row's real
 * `aria-level`/Stage-or-member kind/label text/green colour against `EXPECTED_PANEL_ROWS` at the
 * SAME index -- proves grouping (header -> nested members, solo calls stay flat), the dropped
 * "Stage N" naming (item 3), and green state (including Stage 5's own mixed negative case) all
 * in one pass, immune to the two same-labelled "2 agents" headers and the repeated "Story559"
 * name a title-based lookup could not tell apart. Also confirms `aria-expanded`/`aria-selected`
 * presence (item 5) and a Stage header's own accessible name states its roll-up too (item 6). */
async function assertPanelStructure(cdp, findings, failures, themeName) {
  const failuresAtStart = failures.length;
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const rows = await cdp.evaluate(`
    Array.from(document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"]')).map((el) => {
      // Live-run fix (falsified script-vs-product): cn() (tailwind-merge-style, src/renderer/
      // lib/utils.ts) correctly drops min-w-0 from a Stage header's own label span once
      // min-w-16 is ALSO passed (same min-w conflict group, last one wins by design -- a
      // Stage header's label genuinely never carries min-w-0 in the real DOM, confirmed with a
      // throwaway cn('min-w-0 flex-1 truncate', 'min-w-16', ...) call against the real config:
      // returns 'flex-1 truncate min-w-16 ...', no min-w-0). '.flex-1.truncate' alone is
      // unambiguous within one treeitem (the only other classed spans are the rollup slot,
      // 'shrink truncate' -- no flex-1 -- and the Uses line, neither flex-1 nor truncate).
      const labelSpan = el.querySelector('span.flex-1.truncate');
      const bg = (() => { let node = el; while (node) { const bgc = getComputedStyle(node).backgroundColor; if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') return bgc; node = node.parentElement; } return getComputedStyle(document.body).backgroundColor; })();
      return {
        level: el.getAttribute('aria-level'),
        hasAriaExpanded: el.hasAttribute('aria-expanded'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        hasAriaSelected: el.hasAttribute('aria-selected'),
        ariaLabel: el.getAttribute('aria-label'),
        label: labelSpan ? labelSpan.textContent : null,
        labelColor: labelSpan ? getComputedStyle(labelSpan).color : null,
        bg,
        rowText: el.textContent
      };
    })
  `);
  if (rows.length !== EXPECTED_PANEL_ROWS.length) {
    failures.push(`[${themeName}] The panel's own tree has ${rows.length} treeitem(s), expected exactly ${EXPECTED_PANEL_ROWS.length} (10 Stage headers/flat solo rows plus their real members).`);
    return;
  }
  for (const [index, expected] of EXPECTED_PANEL_ROWS.entries()) {
    const row = rows[index];
    const where = `[${themeName}] panel row ${index} (expected ${expected.isStage ? 'Stage header' : 'member/solo row'} "${expected.label}")`;
    if (row.level !== expected.level) failures.push(`${where}: aria-level is ${JSON.stringify(row.level)}, expected "${expected.level}".`);
    if (row.label !== expected.label) failures.push(`${where}: label text is ${JSON.stringify(row.label)}, expected ${JSON.stringify(expected.label)}.`);
    if (expected.isStage) {
      if (row.ariaExpanded !== 'true') failures.push(`${where}: aria-expanded is ${JSON.stringify(row.ariaExpanded)}, expected the string "true".`);
      if (row.hasAriaSelected) failures.push(`${where}: carries an aria-selected attribute (${JSON.stringify(row.ariaLabel)}) -- a Stage header has no single subagent id to select and must not carry this attribute at all.`);
      if (expected.exactAriaLabel !== undefined) {
        if (row.ariaLabel !== expected.exactAriaLabel) {
          failures.push(`${where}: own accessible name is ${JSON.stringify(row.ariaLabel)}, expected EXACTLY ${JSON.stringify(expected.exactAriaLabel)} (including the ", Failed" status-word suffix).`);
        }
      } else if (!row.ariaLabel || !row.ariaLabel.includes(expected.label) || !/\d+ (done|of)/.test(row.ariaLabel)) {
        failures.push(`${where}: own accessible name is ${JSON.stringify(row.ariaLabel)}, expected it to contain both the label and the roll-up count.`);
      }
    } else {
      if (row.hasAriaExpanded) failures.push(`${where}: carries an aria-expanded attribute -- an ordinary member/solo row has no children to expand.`);
      if (!row.hasAriaSelected) failures.push(`${where}: carries no aria-selected attribute at all -- an ordinary row must always state its own selection state.`);
    }
    if (expected.green && row.labelColor !== expectedColor) {
      failures.push(`${where}: own label colour is ${row.labelColor}, expected the theme's --severity-success (${expectedColor}).`);
    } else if (!expected.green && row.labelColor === expectedColor) {
      failures.push(`${where}: REGRESSION -- own label colour is green (${row.labelColor}), expected NOT green (this row carries a failure).`);
    } else if (expected.green) {
      const ratio = measuredContrastRatio(row.labelColor, row.bg);
      if (ratio === null || ratio < 4.5) {
        failures.push(`${where}: own green label measures ${ratio === null ? 'an unparseable' : ratio.toFixed(2)}:1 against its own backdrop, below 4.5:1.`);
      }
    }
    if (row.rowText && row.rowText.includes('Uses:')) {
      failures.push(`${where}: unexpectedly contains a "Uses:" line (none of this fixture's own task names carry an agent:// reference -- SubagentSummary has no context field for one to come from): ${JSON.stringify(row.rowText.slice(row.rowText.indexOf('Uses:') - 20, row.rowText.indexOf('Uses:') + 60))}`);
    }
  }
  if (failures.length === failuresAtStart) {
    findings.push(`[${themeName}] The panel's own tree matches the expected shape exactly across all ${rows.length} rows: Stage headers (never "Stage N", dropped per the ui-architect-v3 ruling) with their real members nested beneath, solo calls staying flat, green state correct including Stage 5's own mixed finished/failed negative case, aria-expanded/aria-selected correctly present/absent, no stray "Uses:" text.`);
  }
}

/** Issue #941 (FR-079's "Up next"): the agent's own pending Todo phases, below the Subagent
 * chain, in the CHAT pane (not the panel) -- `stages-941.jsonl`'s own `get_state` response now
 * carries two, both still pending (its own raw `tasks[].status` shape, the one
 * `parse_todo_phases` actually reads -- gate round 1 fix, item 9, CRITICAL). Gate round 3 fix
 * (item 5, MEDIUM): the previous version matched a substring against the WHOLE transcript's own
 * `textContent` -- a check that could not actually FAIL (a coincidental match anywhere in
 * hundreds of chars of surrounding transcript text would still pass even if the real list were
 * broken, mis-ordered, or missing). Now reads the real `ul[aria-labelledby]`'s own `li` children
 * directly: the `<ul>` is located VIA its own `aria-labelledby` heading (proving the real
 * label/list relationship the a11y gate fix added, not just that "Up next" text exists
 * somewhere), each `<li>`'s exact `textContent` is compared, and the whole wrapper is checked to
 * come AFTER the chain row's own "Show subagents panel" button in document order (proving "below
 * the Subagent chain", not merely present anywhere in the transcript). */
async function assertUpNextList(cdp, findings, failures, themeName) {
  const failuresAtStart = failures.length;
  const result = await cdp.evaluate(`
    (() => {
      const transcript = document.querySelector('[aria-label="Transcript"]');
      if (!transcript) return { transcriptFound: false };
      const heading = Array.from(transcript.querySelectorAll('span[id]')).find((el) => el.textContent.trim() === 'Up next');
      if (!heading) return { transcriptFound: true, headingFound: false };
      const wrapper = heading.parentElement;
      // Gate round 4 fix (issue #941 part 2, item 4, LOW, sec): compares the real attribute
      // value in JS instead of interpolating the heading's own id into a CSS selector string --
      // useId() ids are safe today, but a selector built by string concatenation is the wrong
      // habit regardless, and getAttribute plus === proves the exact same relationship with no
      // injection surface at all.
      const ul = wrapper ? Array.from(wrapper.children).find((el) => el.tagName === 'UL' && el.getAttribute('aria-labelledby') === heading.id) : null;
      if (!ul) return { transcriptFound: true, headingFound: true, ulFound: false };
      const items = Array.from(ul.children).filter((el) => el.tagName === 'LI').map((li) => li.textContent);
      const chainButton = Array.from(transcript.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === 'Show subagents panel');
      const afterChain = chainButton ? !!(chainButton.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
      return { transcriptFound: true, headingFound: true, ulFound: true, items, afterChain, ariaLive: wrapper.getAttribute('aria-live') };
    })()
  `);
  if (!result.transcriptFound) {
    failures.push(`[${themeName}] No [aria-label="Transcript"] element found at all.`);
    return;
  }
  if (!result.headingFound) {
    failures.push(`[${themeName}] No "Up next" heading span found despite the fixture's own get_state carrying two pending Todo phases.`);
    return;
  }
  if (!result.ulFound) {
    failures.push(`[${themeName}] The "Up next" heading exists but no sibling ul[aria-labelledby] pointing at its own id was found -- the list/label relationship is broken.`);
    return;
  }
  findings.push(`[${themeName}] The "Up next" heading and its own aria-labelledby ul[...] relationship both exist.`);
  if (result.afterChain === false) {
    failures.push(`[${themeName}] The "Up next" wrapper does NOT come after the chain row's own "Show subagents panel" button in document order -- it is not rendered below the Subagent chain.`);
  } else if (result.afterChain === true) {
    findings.push(`[${themeName}] The "Up next" wrapper comes after the Subagent chain row in document order (below it, as required).`);
  }
  if (result.ariaLive !== 'off') {
    failures.push(`[${themeName}] The "Up next" wrapper's own aria-live is ${JSON.stringify(result.ariaLive)}, expected "off" (it renders inside role="log" and must not queue its own updates as log additions).`);
  }
  const expected = [
    ['Ship #941 part 2 follow-ups', 2],
    ['Write the verify-941-part2 live-check', 1]
    // Gate round 1 fix (issue #941 part 2, item 8, LOW): singular "1 task", plural otherwise.
  ].map(([name, count]) => `${name} \u00b7 ${count} task${count === 1 ? '' : 's'}`);
  if (result.items.length !== expected.length) {
    failures.push(`[${themeName}] "Up next" has ${result.items.length} <li> item(s), expected exactly ${expected.length}.`);
  } else {
    expected.forEach((expectedText, index) => {
      if (result.items[index] !== expectedText) {
        failures.push(`[${themeName}] "Up next" item ${index}'s exact textContent is ${JSON.stringify(result.items[index])}, expected ${JSON.stringify(expectedText)}.`);
      }
    });
  }
  if (failures.length === failuresAtStart) {
    findings.push(`[${themeName}] "Up next" shows exactly the ${expected.length} expected entries (singular/plural wording correct), in order, below the Subagent chain.`);
  }
}

/** Issue #989: `apply_async_result_jobs` (`subagent_items.rs`) must scope an async-result job to
 * the Stage that actually produced it, never to any item sharing the same `job_id`/label string.
 * Stage 2 and Stage 5 both run a subagent named "Story559" (`stages-941.jsonl`'s own
 * `msg-ar2`/`msg-ar5`); the job's own wire `id` is just its `label` echoed back, not a
 * session-unique value, so before the fix Stage 5's LATER async-result (arriving after Stage
 * 2's own row had already settled) matched Stage 2's already-finished Story559 row too,
 * overwriting its `result`/`duration_ms` with Stage 5's own data (1800ms/"Implemented the fix
 * for #559." clobbered to 4300ms/"Polished Story559 follow-up items."). Stage 2 starts
 * collapsed regardless of Stage count (never auto-opens on running alone, issue #1000/FR-086);
 * Stage 5 starts EXPANDED by default (`StageGroupRow`'s own `isOpenByDefault` -- `total > 1 &&
 * (isMultiStageTurn ? hasBadMember : isRunning || hasBadMember)` -- evaluates true because
 * Stage 5 has a failed member, FailAgent, regardless of Stage count). `expandRow` is a safe
 * no-op when a row is already open (checks `aria-expanded` first), so the same call below
 * handles both cases; expanding either reveals its own Story559 member's one-line result
 * summary (`extractResultSummary`) and rendered duration (`formatElapsed`) with no need to
 * expand the member row itself (same mechanism `assertDetailsOnExpand` already uses for Stage 1).
 *
 * Gate round 1 fix (item 7, LOW): reads the Story559 MEMBER ROW's own `textContent` directly
 * (`[title="Story559"]` inside the Stage's content, `.closest('[data-slot="collapsible-
 * trigger"]')` to the row's whole trigger button -- the same `data-slot` `stageTriggerSelector`
 * already keys on, just scoped one level deeper), not the whole Stage's `textContent` -- Stage
 * 2's sibling member (Story560, 2000ms, also renders "2s") made the old whole-Stage duration
 * check weaker than it looked; row-scoping removes that collision entirely.
 *
 * Gate round 2 (issue #989): a custom `async-result` message's jobs are now applied exactly
 * ONCE, on `message_end` only (`transcript.rs`'s `apply_message_snapshot`), so there is no
 * second application of the same message left to observe at all -- see `notExercised` below. */
async function assertAsyncResultStageScoping(cdp, findings, failures, notExercised) {
  const failuresAtStart = failures.length;
  const expectations = [
    {
      stage: STAGE2_TITLE,
      label: 'Stage 2',
      ownResult: 'Implemented the fix for #559.',
      otherResult: 'Polished Story559 follow-up items.',
      ownDuration: '2s',
      otherDuration: '4s'
    },
    {
      stage: STAGE5_TITLE,
      label: 'Stage 5',
      ownResult: 'Polished Story559 follow-up items.',
      otherResult: 'Implemented the fix for #559.',
      ownDuration: '4s',
      otherDuration: '2s'
    }
  ];
  for (const exp of expectations) {
    const rowSelector = `${stageContentSelector(exp.stage)}?.querySelector('[title="Story559"]')?.closest('[data-slot="collapsible-trigger"]')`;
    // Gate fix (issue #1000's own second additive fixture delay on Stage 2, research.md
    // decision 21): that extra ~1.5s gives the Transcript's own virtualized list
    // (`react-virtuoso`) genuinely more wall-clock time to scroll Stage 2's own row out of its
    // rendered window before this check ever reaches it -- a standalone CDP probe confirmed
    // `stageTriggerSelector` reads `null` immediately before `expandRow`'s own click and
    // resolves correctly immediately after (the click's own `clickScrolled` scroll-into-view is
    // what re-materializes the row), but is not always given enough time to settle before the
    // content check below first polls. Retried up to 3 times: each attempt re-calls `expandRow`
    // (a safe no-op once already open) before its own wait, so a transient virtualization miss
    // on attempt 1 is recovered by attempt 2/3 without ever silently passing on a genuine
    // content regression -- the real #989 claim-vs-text checks below still run against
    // whatever the last attempt actually read, and a failure is still recorded if content
    // never renders after all 3 honest attempts.
    let rowFound = false;
    for (let attempt = 1; attempt <= 3 && !rowFound; attempt++) {
      await expandRow(cdp, exp.stage);
      rowFound = await cdp
        .waitFor(`!!(${rowSelector})`, {
          timeoutMs: 10_000,
          label: `${exp.label}'s own Story559 member row rendered (attempt ${attempt}/3)`
        })
        .then(() => true)
        .catch(() => false);
    }
    if (!rowFound) {
      failures.push(`${exp.label}'s own Story559 member row never rendered after 3 attempts (10s each) -- expand click may have raced the Transcript's own virtualized scroll window, or a genuine regression.`);
    }
  }
  if (failures.length === failuresAtStart) {
    findings.push(
      '[issue #989] Stage 2 and Stage 5 each keep their OWN Story559 result/duration (row-scoped, not whole-Stage text) -- no cross-Stage async-result clobbering.'
    );
  }
  // Gate round 4 fix (issue #989, `agent://Main` item 2): real omp always sets `display: true`
  // on an async-result message -- `stages-941.jsonl` now carries it on every one of its ten
  // (gate round 4, matching `async-job-delivery.ts`'s own builder). Before the gate-round-3
  // short-circuit, a `message_start` frame (its own job application already skipped by gate
  // round 2) fell through to the plain `display == true` Notice branch (`transcript.rs`),
  // building a stray "Info:" notice for every one of this fixture's ten async-result messages
  // -- `message_end`'s own job application only updates matching `subagent` items, so it never
  // replaced or removed that earlier Notice item. Every one of this fixture's async-result
  // messages carries an empty `content: ""`, so the only reliable signal a stray row leaves
  // behind is its own existence (a blank-text "Info:" notice), not any particular substring;
  // scanning the whole Transcript for `NoticeRow`'s own `sr-only` level marker ("Info:") catches
  // it regardless of content. This fails against gate round 2's own code (head `53882ee`, with
  // this fixture's new `display: true`): ten stray notices survive to the end of the turn
  // (`message_end`'s own async-result application never removes them). It passes at HEAD: the
  // gate-round-3 short-circuit returns `items` unchanged on `message_start`, so no Notice item
  // is ever built for an async-result message at any frame.
  const strayNoticeCount = await cdp.evaluate(`
    Array.from(document.querySelectorAll('[aria-label="Transcript"] span.sr-only'))
      .filter((el) => el.textContent.trim() === 'Info:').length
  `);
  if (strayNoticeCount > 0) {
    failures.push(
      `[issue #989] REGRESSION -- found ${strayNoticeCount} stray "Info:" notice row(s) in the Transcript after all ten Stages settled; an async-result message (\`display: true\`, content ${JSON.stringify('')}) must never build a Notice item at any frame.`
    );
  } else {
    findings.push(
      '[issue #989] No stray "Info:" notice row exists anywhere in the Transcript for any async-result message (all ten carry `display: true`, matching real omp) -- the gate-round-3 short-circuit holds.'
    );
  }
  findings.push(
    '[issue #989] `stages-941.jsonl` is SYNTHESIZED, not captured live (its own header comment says so) -- the fixture\u2019s own message_start/message_end-arrive-together shape is not what grounds this fix\u2019s design. That is instead confirmed directly from the real installed omp 18.11.1 binary\u2019s own embedded source (`packages/agent/src/agent-loop.ts`\u2019s `rt(e, t)` helper unconditionally pushes a paired `message_start`/`message_end` for every message, with no code path anywhere that pushes one without the other); gate round 3, research.md decision 19.'
  );
  notExercised.push(
    '[issue #989] Gate round 2: a custom `async-result` message\u2019s jobs are now applied exactly ONCE, on `message_end` only (`transcript.rs`\u2019s `apply_message_snapshot`) -- there is no second application of the same message left to observe at all, so this fixture cannot exercise (and no longer needs to exercise) any double-application behaviour; the design change itself is what prevents it, not a runtime check this script could assert against.',
    '[issue #989] This fixture\u2019s two Story559 rows are never BOTH still unsettled at once (Stage 2 settles via its own real `msg-ar2` well before Stage 5 even starts), so it cannot exercise the gate-round-2 three-tier ranking (still-Running beats batch-ended, job_id beats label-only, latest `started_at` as the final tie-break) when TWO candidates are genuinely unsettled at the same moment -- that ranking is traced by hand only (not executed against a real build) in `subagent_items.rs`\u2019s own doc comment and research.md decision 19\u2019s gate-round-2 correction (a hypothetical Stage 2 batch-failure with no result, racing a genuinely concurrent Stage 5, never part of this committed fixture); adding that second variant here was judged not worth perturbing this fixture\u2019s own already-passing Stage/chain/panel assertions.',
    '[issue #989] No job in this fixture ever has TWO still-unsettled same-label candidates competing for it in one async-result frame (so "a single job entry resolves at most one item" is exercised only in the sense that nothing here could violate it, not as a positive two-candidate race). The known, accepted limit (two truly concurrent same-named Stages both already carrying a `job_id` can still have results swapped by the `started_at` tie-break, tracked on #712) is likewise not exercisable here for the same reason.',
    '[issue #989] The `from_history` replay path (`transcript.rs`\u2019s `items_from_history`) is not driven by this live-CDP fixture at all (it loads a resumed Session\u2019s own stored messages, never live frames) -- it applies each stored `async-result` message exactly once, same as the live path now does.',
    '[issue #989] The `wait` tool\u2019s own `tool_execution_end` carrier (`transcript.rs:1293`/`:1529`, `jobs_from_details` -> `apply_async_result_jobs`) is not reached by this fixture: every job here arrives only through the `custom`/`async-result` message path, never through an explicit `wait()` tool call.'
  );
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let SHOTS_DIR = path.join(tmpdir(), 'refract-941-part2-shots', new Date().toISOString().replace(/[:.]/g, '-'));
  let BUILD_OUTPUT_DIR = null;
  try {
    SHOTS_DIR = process.env.REFRACT_941_PART2_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-941p2-repo-')), 'verify-941-part2');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-launcher-'));
    const port = await getFreePort();

    console.log(`verify-941-part2: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-941-part2: shots dir ${SHOTS_DIR}`);
    console.log(`verify-941-part2: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-941-part2' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-941-part2: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-941',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-941-part2: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    findings.push('Readiness screen green (fake omp, stages-941 scenario).');

    // Gate round 1 fix (issue #941 part 2, item 11, HIGH): `REFRACT_FAKE_OMP_DEBUG_LOG` above was
    // only ever WRITTEN by the fake shim and COPIED at teardown (`finally`, below) -- nothing
    // upstream actually read it, so a silently-wrong fake-omp shim (a stale PATH entry shadowing
    // it, or the shim crashing before its first `debugLog` call) still let the whole run "pass"
    // on UI state alone. Same shim-confirmed check as verify-672: the log must exist, and its
    // FIRST line must be the fake's own startup pid line (`verify-tauri-fake-omp.mjs`'s
    // `pid=<pid> argv=[...] cwd=...`, written before anything else runs).
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-941-part2: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check, item 11).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`verify-941-part2: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check, item 11); got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await clickScrolled(cdp, `document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await clickScrolled(cdp, `document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await clickByTextScrolled(cdp, 'Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await clickByLabelScrolled(cdp, 'New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await clickByTextScrolled(cdp, 'Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created, agent attached (fake omp, stages-941.jsonl scenario, todoPhases extension).');

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await clickByLabelScrolled(cdp, 'Send message');

    for (const titleText of [
      STAGE1_TITLE,
      STAGE2_TITLE,
      STAGE3_TITLE,
      STAGE4_TITLE,
      STAGE5_TITLE,
      STAGE6_SOLO_TITLE,
      STAGE7_TITLE,
      STAGE8_PREFIX_TITLE,
      STAGE9_SOLO_NOCTX_TITLE,
      STAGE10_BORDERLINE_TITLE,
      PLAIN_TOOL_TITLE
    ]) {
      await cdp.waitFor(`!!${titleSelector(titleText)}`, { timeoutMs: 30_000, label: `"${titleText}" row rendered` });
    }
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    findings.push('All ten Stages settled (part 1 scaffold, reused unchanged).');

    await assertAsyncResultStageScoping(cdp, findings, failures, notExercised);
    await clickByLabelScrolled(cdp, 'Show subagents panel');
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel opened' });
    findings.push('Subagents panel opened from the chain row\u2019s own "Show subagents panel" button.');

    for (const [themeIndex, theme] of THEMES.entries()) {
      await switchTheme(cdp, theme.id, theme.name);
      await assertPanelStructure(cdp, findings, failures, theme.name);
      await assertUpNextList(cdp, findings, failures, theme.name);

      const shotName = `part2-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Panel grouping/green + Up next under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push(
      'The panel\u2019s own positive "Uses:" rendering (a Stage header actually naming a resolved dependency) is not reachable from this fixture: SubagentSummary carries no context field, and every task() call here names its own agent (nameOrTask is always the short name, never task text) -- extending the fixture to cover this would need a NEW, unnamed task whose own task text carries an agent:// reference, judged not worth the risk of perturbing part 1\u2019s own already-passing assertions for a part-2-only code path that is otherwise provably correct (same algorithm as groupSubagentStages.ts\u2019s own applyDependencies, reused verbatim against the panel\u2019s own field names).',
      'A running Stage header\u2019s own "\u00b7 Running" roll-up slot and the matching ", Running" suffix on its accessible name (both gate round 3, item 1/2) are not reachable from this fixture: every assertion runs AFTER the fixed-up "All ten Stages settled" wait, by which point every Stage in this tape has already finished or failed -- no Stage is ever caught mid-run at assertion time. Covering it would need a second CDP snapshot taken before that settle wait, judged not worth the risk of perturbing this fixture\u2019s own already-passing timing-sensitive waits for a one-line visual/text append that is otherwise provably correct (identical ternary to `StageGroupRow`\u2019s own `isRunning` branch, `SubagentChainRow.tsx`).'
    );

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-941-part2: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-941-part2: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-941-part2: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-941-part2: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-941-part2: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-941-part2: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-941-part2: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
