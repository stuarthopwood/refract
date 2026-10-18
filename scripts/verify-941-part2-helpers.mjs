#!/usr/bin/env node
// Split out of `verify-941-part2.mjs` (#806 600-line file-size discipline, issue #1000's gate-B
// fix pushed the main script over the 600-line cap): the #989 async-result Stage-scoping
// assertion, self-contained (only needs `cdp` plus the shared Stage title/selector/expand
// helpers), so it moves here unchanged.

import { stageContentSelector, expandRow, STAGE2_TITLE, STAGE5_TITLE } from './verify-941-stage-naming-helpers.mjs';

/** Issue #989: `apply_async_result_jobs` (`subagent_items.rs`) must scope an async-result job to
 * the Stage that actually produced it, never to any item sharing the same `job_id`/label string.
 * Stage 2 and Stage 5 both run a subagent named "Story559" (`stages-941.jsonl`'s own
 * `msg-ar2`/`msg-ar5`); the job's own wire `id` is just its `label` echoed back, not a
 * session-unique value, so before the fix Stage 5's LATER async-result (arriving after Stage
 * 2's own row had already settled) matched Stage 2's already-finished Story559 row too,
 * overwriting its `result`/`duration_ms` with Stage 5's own data (1800ms/"Implemented the fix
 * for #559." clobbered to 4300ms/"Polished Story559 follow-up items."). Stage 2 starts
 * collapsed regardless of Stage count (never auto-opens on running alone, issue #1000/FR-087);
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
export async function assertAsyncResultStageScoping(cdp, findings, failures, notExercised) {
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
    // decision 22): that extra ~1.5s gives the Transcript's own virtualized list
    // (`react-virtuoso`) genuinely more wall-clock time to scroll Stage 2's own row out of its
    // rendered window before this check ever reaches it -- a standalone CDP probe confirmed
    // `stageTriggerSelector` reads `null` immediately before `expandRow`'s own click and
    // resolves correctly immediately after (the click's own `clickScrolled` scroll-into-view is
    // what re-materializes the row), but is not always given enough time to settle before the
    // content check below first polls. Retried up to 3 times: each attempt re-calls `expandRow`
    // (a safe no-op once already open) before its own wait, so a transient virtualization miss
    // on attempt 1 is recovered by attempt 2/3 without ever silently passing on a genuine
    // content regression -- once `rowFound`, the real #989 claim-vs-text checks below run
    // against that exact row; if the row never renders after all 3 honest attempts, a failure
    // is recorded and the text checks are skipped (there is no row left to read).
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
      continue;
    }
    const rowText = await cdp.evaluate(`(${rowSelector})?.textContent ?? ''`);
    if (!rowText.includes(exp.ownResult)) {
      failures.push(
        `[issue #989] ${exp.label}'s own Story559 member row does not show its OWN result summary (${JSON.stringify(exp.ownResult)}): ${JSON.stringify(rowText)}`
      );
    } else {
      findings.push(`[issue #989] ${exp.label}'s own Story559 member row correctly shows its own result summary (${JSON.stringify(exp.ownResult)}).`);
    }
    if (rowText.includes(exp.otherResult)) {
      failures.push(
        `[issue #989] REGRESSION -- ${exp.label}'s own Story559 member row shows the OTHER Stage's result summary (${JSON.stringify(exp.otherResult)}): a same-named Stage's later async-result clobbered this row.`
      );
    }
    if (!rowText.includes(exp.ownDuration)) {
      failures.push(`[issue #989] ${exp.label}'s own Story559 member row does not show its OWN duration (${JSON.stringify(exp.ownDuration)}): ${JSON.stringify(rowText)}`);
    } else {
      findings.push(`[issue #989] ${exp.label}'s own Story559 member row correctly shows its own duration (${JSON.stringify(exp.ownDuration)}).`);
    }
    if (rowText.includes(exp.otherDuration)) {
      failures.push(
        `[issue #989] REGRESSION -- ${exp.label}'s own Story559 member row shows the OTHER Stage's duration (${JSON.stringify(exp.otherDuration)}), which it never legitimately renders on its own: ${JSON.stringify(rowText)}`
      );
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
