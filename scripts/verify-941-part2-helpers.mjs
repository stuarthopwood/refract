#!/usr/bin/env node
// Verifies async-result jobs are scoped to the Stage that produced them (#989).

import { stageContentSelector, expandRow, STAGE2_TITLE, STAGE5_TITLE } from './verify-941-stage-naming-helpers.mjs';

/** Stage 2 and Stage 5 both run a subagent named "Story559" and an async-result's wire `id` is only its label,
 * so a later result must not overwrite the earlier Stage's row. Reads the member row, not the whole Stage text,
 * because sibling Story560 also renders "2s". `expandRow` is a no-op on an already-open row. */
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
    // react-virtuoso can scroll the row out of the rendered window before this check reaches it; expandRow's
    // scroll re-materializes it, so retry (expandRow is a no-op when already open).
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
      failures.push(`[issue #989] ${exp.label}'s own Story559 member row never rendered after 3 attempts (10s each) -- expand click may have raced the Transcript's own virtualized scroll window, or a genuine regression.`);
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
  // Real omp sets `display: true` on async-result messages; a message_start must not build a stray blank "Info:" notice.
  // The content is empty, so the notice's existence (sr-only "Info:" marker) is the only signal.
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
