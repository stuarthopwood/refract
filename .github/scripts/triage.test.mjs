import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEntry, findViolations, resolveFeatureDirectory } from "./prep-guard.mjs";
import {
  heuristicClassify,
  isSpecRelated,
  mergeWithExisting,
  normalise,
  parseMarker,
  parseModelJson,
  PRIORITIES,
  renderComment,
  renderMarker,
  sanitizeRationale,
  STATES,
  TYPES,
} from "./triage.mjs";

const issue = (title, body = "A sufficiently long description of the requested change goes here.", extra = {}) => ({
  number: 1,
  title,
  body,
  ...extra,
});

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

test("isSpecRelated matches spec/FR/task references and plain text does not", () => {
  assert.equal(isSpecRelated(issue("x", "see FR-012")), true);
  assert.equal(isSpecRelated(issue("x", "spec:002 follow-up")), true);
  assert.equal(isSpecRelated(issue("x", "just a normal request")), false);
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

test("normalise reports heuristic as the source when no field in the model reply was usable", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  assert.equal(normalise({}, fallback, new Set()).source, "heuristic");
  assert.equal(normalise(null, fallback, new Set()).source, "heuristic");
});

test("normalise reports model as the source once at least one field matched the vocabulary", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  // type/priority/route are all out of vocabulary (fall back), but state is valid.
  const c = normalise({ type: "nonsense", priority: "p9", speckit_route: "rm -rf", state: "ready-for-agent" }, fallback, new Set());
  assert.equal(c.source, "model");
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

test("needs-info always forces route to none even when the model suggested one", () => {
  const model = { type: "bug", area: null, priority: "p1", state: "needs-info", route: "specify" };
  assert.equal(mergeWithExisting(model, []).route, "none");
});

test("a maintainer-set bug/chore type re-derives the route exactly like the heuristic would (converge if spec-related, none otherwise)", () => {
  const model = { type: "enhancement", area: null, priority: "p2", state: "ready-for-agent", route: "specify" };
  assert.equal(mergeWithExisting(model, ["bug"], { specRelated: false }).route, "none");
  assert.equal(mergeWithExisting(model, ["bug"], { specRelated: true }).route, "converge");
});

test("a model-chosen specify route survives a maintainer chore/design type; the heuristic's does not", () => {
  const base = { area: null, priority: "p1", state: "ready-for-agent", route: "specify" };
  for (const label of ["chore", "design", "bug"]) {
    const fromModel = mergeWithExisting({ ...base, type: "enhancement", source: "model" }, [label], { specRelated: false });
    assert.equal(fromModel.route, "specify", `model route kept for ${label}`);
    const fromHeuristic = mergeWithExisting({ ...base, type: "enhancement", source: "heuristic" }, [label], { specRelated: false });
    assert.equal(fromHeuristic.route, "none", `heuristic route dropped for ${label}`);
  }
  const docs = mergeWithExisting({ ...base, type: "enhancement", source: "model" }, ["documentation"]);
  assert.equal(docs.route, "none");
});

test("force re-triage ignores the bot's own prior labels and clears every stale bot-owned label", () => {
  const priorBotLabels = ["bug", "p1", "ready-for-human", "triaged"];
  const existingLabels = [...priorBotLabels];
  // This run's fresh classification disagrees with the bot's own earlier guess
  // on every dimension (type, priority, state), not just state.
  const classification = { type: "enhancement", area: null, priority: "p2", state: "ready-for-agent", route: "specify" };
  const m = mergeWithExisting(classification, existingLabels, { botLabels: priorBotLabels });
  // Not overridden back to "bug"/"p1": those were the bot's own labels, not a maintainer's.
  assert.equal(m.type, "enhancement");
  assert.equal(m.priority, "p2");
  // Every stale bot-owned label this run disagrees with is queued for removal.
  assert.deepEqual(m.labelsToRemove.sort(), ["bug", "p1", "ready-for-human"].sort());
  assert.ok(m.labelsToAdd.includes("ready-for-agent"));
});

test("two consecutive runs converge to exactly one type/priority/state label each", () => {
  const run1 = mergeWithExisting(
    { type: "bug", area: null, priority: "p1", state: "ready-for-human", route: "none" },
    [],
    { botLabels: [] },
  );
  const labelsAfterRun1 = run1.labelsToAdd;
  assert.deepEqual(labelsAfterRun1.sort(), ["bug", "p1", "ready-for-human", "triaged"].sort());

  const run2 = mergeWithExisting(
    { type: "enhancement", area: null, priority: "p2", state: "ready-for-agent", route: "specify" },
    labelsAfterRun1,
    { botLabels: run1.botLabels },
  );
  assert.deepEqual(run2.labelsToRemove.sort(), ["bug", "p1", "ready-for-human"].sort());
  assert.deepEqual(run2.labelsToAdd.sort(), ["enhancement", "p2", "ready-for-agent"].sort());

  const finalLabels = new Set([...labelsAfterRun1, ...run2.labelsToAdd].filter((l) => !run2.labelsToRemove.includes(l)));
  assert.equal([...finalLabels].filter((l) => TYPES.includes(l)).length, 1);
  assert.equal([...finalLabels].filter((l) => PRIORITIES.includes(l)).length, 1);
  assert.equal([...finalLabels].filter((l) => STATES.includes(l)).length, 1);
});

test("maintainer label matching is case-insensitive but removal keeps the real label casing", () => {
  const classification = { type: "enhancement", area: null, priority: "p2", state: "needs-triage", route: "none" };
  // "Needs-Info" is bot-owned (from a prior marker); "Bug" is not, so it wins
  // as a maintainer override and is never queued for removal.
  const m = mergeWithExisting(classification, ["Bug", "Needs-Info"], { botLabels: ["needs-info"] });
  assert.equal(m.type, "bug");
  assert.deepEqual(m.labelsToRemove, ["Needs-Info"]);
});

test("rationale is rendered as a code span so links, images, and auto-references are neutralised", () => {
  const c = {
    type: "bug", area: null, priority: "p2", state: "ready-for-agent", route: "none",
    rationale: "See #42 and [click](http://evil) ![img](http://evil.example/x.png) `inject`",
    source: "heuristic", botLabels: ["bug", "p2", "ready-for-agent", "triaged"],
  };
  const comment = renderComment(c, { number: 9 });
  assert.ok(comment.includes("`See #42 and [click](http://evil) ![img](http://evil.example/x.png) 'inject'`"));
});

test("sanitizeRationale collapses newlines and neutralises embedded backticks", () => {
  assert.equal(sanitizeRationale("line one\nline two `x`"), "line one line two 'x'");
});

test("renderComment only promises prep will run when prep is actually gated true", () => {
  const c = { type: "feature", area: null, priority: "p2", state: "ready-for-agent", route: "specify", rationale: "ok", source: "model", botLabels: [] };
  const ready = renderComment(c, { number: 1 }, { trusted: true, hasKey: true, prep: true });
  assert.match(ready, /Next: the `prep-agent` job will run/);

  const noKey = renderComment(c, { number: 1 }, { trusted: true, hasKey: false, prep: false });
  assert.match(noKey, /ANTHROPIC_API_KEY.*not configured/);
  assert.doesNotMatch(noKey, /Next: the `prep-agent` job will run/);

  const untrusted = renderComment(c, { number: 1 }, { trusted: false, hasKey: true, prep: false });
  assert.match(untrusted, /not a repository collaborator with write access/);
});

test("the marker round-trips the bot's label set as JSON", () => {
  const marker = renderMarker(["bug", "p1", "ready-for-human", "triaged"]);
  assert.equal(marker, '<!-- pinion-issue-triage {"labels":["bug","p1","ready-for-human","triaged"]} -->');
  assert.deepEqual(parseMarker(`some text\n${marker}\nmore text`), ["bug", "p1", "ready-for-human", "triaged"]);
});

test("parseMarker returns null for a missing or corrupt marker", () => {
  assert.equal(parseMarker("no marker here"), null);
  assert.equal(parseMarker("<!-- pinion-issue-triage not json -->"), null);
  assert.equal(parseMarker(undefined), null);
});

test("model JSON is extracted from fenced or chatty replies and rejected when absent", () => {
  assert.deepEqual(parseModelJson('Sure:\n```json\n{"type":"bug","duplicate_of":null}\n```'), { type: "bug", duplicate_of: null });
  assert.throws(() => parseModelJson("I cannot classify this."));
});

test("classifyEntry accepts a markdown file inside a numbered spec directory and inside docs", () => {
  assert.deepEqual(classifyEntry({ path: "specs/001-core-session-workspace/spec.md", isFile: true, isSymlink: false, size: 10 }), { ok: true });
  assert.deepEqual(classifyEntry({ path: "docs/issue-triage.md", isFile: true, isSymlink: false, size: 10 }), { ok: true });
});

test("classifyEntry rejects a symlink even when the path otherwise matches", () => {
  const r = classifyEntry({ path: "specs/001-core-session-workspace/spec.md", isFile: false, isSymlink: true, size: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /symlink/);
});

test("classifyEntry rejects runnable code under docs/", () => {
  const r = classifyEntry({ path: "docs/spike/probe.mjs", isFile: true, isSymlink: false, size: 10 });
  assert.equal(r.ok, false);
});

test("classifyEntry rejects a non-markdown file inside a spec directory", () => {
  const r = classifyEntry({ path: "specs/002-issue-triage-automation/feature.json", isFile: true, isSymlink: false, size: 10 });
  assert.equal(r.ok, false);
});

test("classifyEntry rejects a root-level file", () => {
  const r = classifyEntry({ path: "package.json", isFile: true, isSymlink: false, size: 10 });
  assert.equal(r.ok, false);
});

test("classifyEntry rejects a path traversal segment even nested inside an allowed prefix", () => {
  const r = classifyEntry({ path: "specs/001-core-session-workspace/../../etc/passwd", isFile: true, isSymlink: false, size: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /escapes/);
});

test("classifyEntry rejects a file over the size limit", () => {
  const r = classifyEntry({ path: "docs/big.md", isFile: true, isSymlink: false, size: 2 * 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds/);
});

test("findViolations rejects code, workflows, traversal, and absolute paths", () => {
  const bad = ["src/main/index.ts", ".github/workflows/issue-triage.yml", "specs/../package.json", "/etc/passwd", "specs-evil/x.md", "package.json"];
  assert.deepEqual(findViolations(bad), bad);
});

test("findViolations accepts spec and docs markdown changes", () => {
  assert.deepEqual(findViolations(["specs/002-issue-triage-automation/spec.md", "docs/a.md"]), []);
});

test("resolveFeatureDirectory only ever resolves for the converge route", () => {
  assert.equal(resolveFeatureDirectory("specify", ["spec:002"], ["002-issue-triage-automation"]), null);
  assert.equal(resolveFeatureDirectory("none", [], ["001-core-session-workspace"]), null);
});

test("resolveFeatureDirectory maps a spec:NNN label to its existing directory", () => {
  assert.equal(
    resolveFeatureDirectory("converge", ["spec:002"], ["001-core-session-workspace", "002-issue-triage-automation"]),
    "specs/002-issue-triage-automation",
  );
});

test("resolveFeatureDirectory returns null for a spec:NNN label with no matching directory", () => {
  assert.equal(resolveFeatureDirectory("converge", ["spec:999"], ["001-core-session-workspace"]), null);
});

test("resolveFeatureDirectory falls back to the default feature when no spec:NNN label is present", () => {
  assert.equal(
    resolveFeatureDirectory("converge", ["bug"], ["001-core-session-workspace", "002-issue-triage-automation"]),
    "specs/001-core-session-workspace",
  );
});

test("resolveFeatureDirectory returns null when there is no label and no default feature to fall back to", () => {
  assert.equal(resolveFeatureDirectory("converge", [], ["002-issue-triage-automation"]), null);
});
