import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOFT_CAP,
  checkAgainstBaseline,
  computeUpdatedBaseline,
  findRemovableBaselineEntries,
  isExcludedPath,
} from "./check-file-size.mjs";

test("checkAgainstBaseline fails a new file over the cap", () => {
  const files = [{ relative: "src/new.ts", lineCount: 601 }];
  const { offenders, failures } = checkAgainstBaseline(files, {});
  assert.equal(offenders.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(offenders[0].failing, true);
  assert.equal(offenders[0].baselineCount, null);
});

test("checkAgainstBaseline fails a baseline file that grew past its recorded size", () => {
  const baseline = { "src/big.ts": 700 };
  const files = [{ relative: "src/big.ts", lineCount: 701 }];
  const { offenders, failures } = checkAgainstBaseline(files, baseline);
  assert.equal(failures.length, 1);
  assert.equal(offenders[0].failing, true);
  assert.equal(offenders[0].baselineCount, 700);
});

test("checkAgainstBaseline passes a baseline file that shrank, reporting the lower number", () => {
  const baseline = { "src/big.ts": 900 };
  const files = [{ relative: "src/big.ts", lineCount: 650 }];
  const { offenders, failures } = checkAgainstBaseline(files, baseline);
  assert.equal(failures.length, 0);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].failing, false);
  assert.equal(offenders[0].lineCount, 650);
});

test("checkAgainstBaseline passes a file at exactly the 600-line cap", () => {
  const files = [{ relative: "src/exact.ts", lineCount: SOFT_CAP }];
  const { offenders, failures } = checkAgainstBaseline(files, {});
  assert.deepEqual(offenders, []);
  assert.deepEqual(failures, []);
});

test("excluded paths (test files, vendored UI) are never flagged even when huge", () => {
  const candidates = [
    { relative: "src/renderer/components/ui/button.tsx", lineCount: 5000 },
    { relative: "src/big.test.ts", lineCount: 5000 },
    { relative: "scripts/check-file-size.test.mjs", lineCount: 5000 },
  ];
  const filtered = candidates.filter((f) => !isExcludedPath(f.relative));
  assert.deepEqual(filtered, []);
  const { offenders, failures } = checkAgainstBaseline(filtered, {});
  assert.deepEqual(offenders, []);
  assert.deepEqual(failures, []);
});

test("isExcludedPath does not exclude an ordinary over-cap source file", () => {
  assert.equal(isExcludedPath("src/renderer/features/chat/MessageInput.tsx"), false);
});

test("findRemovableBaselineEntries reports a shrunk-below-cap entry and a deleted entry", () => {
  const baseline = { "src/shrunk.ts": 900, "src/gone.ts": 800, "src/still-big.ts": 1000 };
  const files = [
    { relative: "src/shrunk.ts", lineCount: 500 },
    { relative: "src/still-big.ts", lineCount: 1000 },
  ];
  const removable = findRemovableBaselineEntries(files, baseline);
  assert.deepEqual(removable.sort(), ["src/gone.ts", "src/shrunk.ts"]);
});

test("computeUpdatedBaseline lowers an entry to its current smaller line count", () => {
  const baseline = { "src/big.ts": 900 };
  const files = [{ relative: "src/big.ts", lineCount: 650 }];
  assert.deepEqual(computeUpdatedBaseline(files, baseline), { "src/big.ts": 650 });
});

test("computeUpdatedBaseline never raises an entry for a file that grew", () => {
  const baseline = { "src/big.ts": 700 };
  const files = [{ relative: "src/big.ts", lineCount: 750 }];
  assert.deepEqual(computeUpdatedBaseline(files, baseline), { "src/big.ts": 700 });
});

test("computeUpdatedBaseline drops entries for files that are gone or shrank to <= cap", () => {
  const baseline = { "src/gone.ts": 800, "src/shrunk.ts": 900 };
  const files = [{ relative: "src/shrunk.ts", lineCount: 400 }];
  assert.deepEqual(computeUpdatedBaseline(files, baseline), {});
});

test("computeUpdatedBaseline never adds a new entry for an over-cap file not already baselined", () => {
  const files = [{ relative: "src/new-god-file.ts", lineCount: 900 }];
  assert.deepEqual(computeUpdatedBaseline(files, {}), {});
});
