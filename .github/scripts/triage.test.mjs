import assert from "node:assert/strict";
import { test } from "node:test";
import { heuristicClassify, mergeWithExisting, normalise } from "./triage.mjs";
import { findViolations, parsePorcelain } from "./prep-guard.mjs";

const issue = (title, body = "A sufficiently long description of the requested change goes here.") => ({ title, body });

test("heuristic classifies a crash report as a p1 bug", () => {
  const c = heuristicClassify(issue("App crash when opening a session", "It crashes every time I open a worktree session on start."));
  assert.equal(c.type, "bug");
  assert.equal(c.priority, "p1");
});

test("heuristic marks a near-empty issue as needs-info", () => {
  assert.equal(heuristicClassify(issue("Add thing", "")).state, "needs-info");
});

test("heuristic routes spec-related changes to converge and new features to specify", () => {
  assert.equal(heuristicClassify(issue("Add dark mode toggle")).route, "specify");
  assert.equal(heuristicClassify(issue("Add dark mode toggle", "Update FR-012 in the spec so the toggle is persisted properly.")).route, "converge");
});

test("normalise replaces out-of-vocabulary model fields with the fallback", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  const c = normalise({ type: "nonsense", priority: "p9", speckit_route: "rm -rf", state: "ready-for-agent" }, fallback, new Set());
  assert.equal(c.type, fallback.type);
  assert.equal(c.priority, fallback.priority);
  assert.equal(c.route, fallback.route);
  assert.equal(c.state, "ready-for-agent");
});

test("normalise ignores a duplicate_of that is not an open issue and blocks prep for real duplicates", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  assert.equal(normalise({ duplicate_of: 7 }, fallback, new Set()).duplicate_of, null);
  const dup = normalise({ duplicate_of: 7, speckit_route: "specify", state: "ready-for-agent" }, fallback, new Set([7]));
  assert.deepEqual([dup.duplicate_of, dup.route, dup.state], [7, "none", "needs-triage"]);
});

test("maintainer-set labels win and are never re-added", () => {
  const model = { type: "enhancement", area: "chat", priority: "p3", state: "ready-for-agent", route: "specify" };
  const m = mergeWithExisting(model, ["chore", "p1"]);
  assert.equal(m.type, "chore");
  assert.equal(m.priority, "p1");
  assert.deepEqual(m.labelsToAdd.sort(), ["chat", "ready-for-agent", "triaged"]);
});

test("a maintainer-chosen documentation type cancels spec prep", () => {
  const model = { type: "feature", area: null, priority: "p2", state: "ready-for-agent", route: "specify" };
  assert.equal(mergeWithExisting(model, ["documentation"]).route, "none");
});

test("guard accepts spec and docs changes plus scratch output", () => {
  assert.deepEqual(
    findViolations(["specs/002-x/spec.md", "docs/a.md", ".specify/feature.json", ".triage/issue-9.md"]),
    [],
  );
});

test("guard rejects code, workflows, traversal, and absolute paths", () => {
  const bad = ["src/main/index.ts", ".github/workflows/issue-triage.yml", "specs/../package.json", "/etc/passwd", "specs-evil/x.md", "package.json"];
  assert.deepEqual(findViolations(bad), bad);
});

test("porcelain parser reads untracked, modified, and renamed entries", () => {
  const out = " M specs/a.md\0?? docs/b.md\0R  specs/new.md\0src/old.ts\0";
  assert.deepEqual(parsePorcelain(out), ["specs/a.md", "docs/b.md", "specs/new.md", "src/old.ts"]);
  assert.deepEqual(findViolations(parsePorcelain(out)), ["src/old.ts"]);
});
