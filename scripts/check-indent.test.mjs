import assert from "node:assert/strict";
import { test } from "node:test";
import { findNestingInversions, findOddIndentLines } from "./check-indent.mjs";

test("findOddIndentLines ignores blank lines and lines already at 0 indent", () => {
  const lines = ["function foo() {", "", "  return 1;", "}"];
  assert.deepEqual(findOddIndentLines(lines), []);
});

test("findOddIndentLines flags a line with an odd leading-space count", () => {
  const lines = ["function foo() {", " return 1;", "}"];
  const bad = findOddIndentLines(lines);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].lineNo, 2);
  assert.equal(bad[0].indent, 1);
});

test("findOddIndentLines excludes JSDoc continuation and closing-delimiter lines", () => {
  const lines = ["/**", " * some comment", " */", "function foo() {}"];
  assert.deepEqual(findOddIndentLines(lines), []);
});

test("findOddIndentLines reports multiple odd lines in file order", () => {
  const lines = ["if (x) {", " a();", "  b();", " c();", "}"];
  const bad = findOddIndentLines(lines);
  assert.deepEqual(
    bad.map((b) => b.lineNo),
    [2, 4]
  );
});

test("findNestingInversions is clean for correctly nested, uniformly 2-space code", () => {
  const lines = [
    "function main() {",
    "  try {",
    "    risky();",
    "  } catch {",
    "    handle();",
    "  }",
    "}",
  ];
  assert.deepEqual(findNestingInversions(lines), []);
});

test("findNestingInversions flags a block body indented less than its own opener", () => {
  // Same shape as the scrambled .github/scripts/triage.mjs restoration: a block's body
  // ends up dedented below the line that opened it (`try {`), even though indentation
  // elsewhere in the file is otherwise consistent.
  const clearlyInverted = [
    "function main() {",
    "  try {",
    "risky();", // indent 0, less than the "  try {" opener's own indent of 2
    "  } catch {",
    "    handle();",
    "  }",
    "}",
  ];
  const violations = findNestingInversions(clearlyInverted);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].lineNo, 3);
  assert.equal(violations[0].indent, 0);
  assert.equal(violations[0].openerIndent, 2);
});

test("findNestingInversions does not flag a closing line indented back to its opener's level", () => {
  const lines = ["const config = {", "  a: 1,", "  nested: {", "    b: 2", "  }", "};"];
  assert.deepEqual(findNestingInversions(lines), []);
});

test("findNestingInversions strips trailing line comments before counting brackets", () => {
  const lines = ["function foo() { // a comment with a stray {", "  return 1;", "}"];
  assert.deepEqual(findNestingInversions(lines), []);
});
