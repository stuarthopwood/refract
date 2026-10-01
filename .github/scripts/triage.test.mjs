import assert from "node:assert/strict";
import { test } from "node:test";
import {
  heuristicClassify,
  isSpecRelated,
  mergeWithExisting,
  normalise,
  parseMarker,
  parseModelJson,
  renderComment,
  renderMarker,
  renderPickupPlan,
  resolveFeatureDirectory,
  sanitizeRationale,
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

test("heuristicClassify always returns an empty pickup_notes array", () => {
  assert.deepEqual(heuristicClassify(issue("Add thing")).pickup_notes, []);
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

test("normalise ignores a duplicate_of that is not an open issue and blocks the route for real duplicates", () => {
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

test("normalise caps pickup_notes at 4 entries of at most 160 characters each, dropping non-strings and blanks", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  const longNote = "x".repeat(200);
  const raw = { pickup_notes: ["a", 42, "", "  ", "b", "c", "d", "e", longNote] };
  const c = normalise(raw, fallback, new Set());
  assert.deepEqual(c.pickup_notes, ["a", "b", "c", "d"]);
  assert.ok(c.pickup_notes.every((n) => n.length <= 160));
});

test("normalise defaults pickup_notes to an empty array when absent or malformed", () => {
  const fallback = heuristicClassify(issue("Add dark mode toggle"));
  assert.deepEqual(normalise({}, fallback, new Set()).pickup_notes, []);
  assert.deepEqual(normalise({ pickup_notes: "not an array" }, fallback, new Set()).pickup_notes, []);
});

test("maintainer-set labels win and are never re-added", () => {
  const model = { type: "enhancement", area: "chat", priority: "p3", state: "ready-for-agent", route: "specify" };
  const m = mergeWithExisting(model, ["chore", "p1"]);
  assert.equal(m.type, "chore");
  assert.equal(m.priority, "p1");
  assert.deepEqual(m.labelsToAdd.sort(), ["chat", "ready-for-agent", "triaged"]);
});

test("a maintainer-chosen documentation type cancels the Spec Kit route", () => {
  const model = { type: "feature", area: null, priority: "p2", state: "ready-for-agent", route: "specify" };
  assert.equal(mergeWithExisting(model, ["documentation"]).route, "none");
});

test("needs-info always forces route to none even when the model suggested one", () => {
  const model = { type: "bug", area: null, priority: "p1", state: "needs-info", route: "specify" };
  assert.equal(mergeWithExisting(model, []).route, "none");
});

test("ready-for-human keeps its real route instead of being forced to none", () => {
  const model = { type: "enhancement", area: null, priority: "p2", state: "ready-for-human", route: "specify", source: "model" };
  assert.equal(mergeWithExisting(model, []).route, "specify");
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
  const TYPES_SET = ["bug", "enhancement", "feature", "documentation", "spike", "chore", "question", "design"];
  const PRIORITIES_SET = ["p1", "p2", "p3"];
  const STATES_SET = ["ready-for-agent", "ready-for-human", "needs-info", "needs-triage"];
  assert.equal([...finalLabels].filter((l) => TYPES_SET.includes(l)).length, 1);
  assert.equal([...finalLabels].filter((l) => PRIORITIES_SET.includes(l)).length, 1);
  assert.equal([...finalLabels].filter((l) => STATES_SET.includes(l)).length, 1);
});

test("maintainer label matching is case-insensitive but removal keeps the real label casing", () => {
  const classification = { type: "enhancement", area: null, priority: "p2", state: "needs-triage", route: "none" };
  // "Needs-Info" is bot-owned (from a prior marker); "Bug" is not, so it wins
  // as a maintainer override and is never queued for removal.
  const m = mergeWithExisting(classification, ["Bug", "Needs-Info"], { botLabels: ["needs-info"] });
  assert.equal(m.type, "bug");
  assert.deepEqual(m.labelsToRemove, ["Needs-Info"]);
});

test("a maintainer-set state label is honoured like type/area/priority, not left alongside the bot's stale guess", () => {
  const classification = { type: "chore", area: null, priority: "p1", state: "ready-for-human", route: "specify", source: "model" };
  const m = mergeWithExisting(classification, ["chore", "p1", "triaged", "ready-for-agent"], { botLabels: ["triaged"] });
  assert.equal(m.state, "ready-for-agent");
  assert.ok(!m.labelsToAdd.includes("ready-for-human"));
  assert.deepEqual(m.labelsToRemove, []);
});

test("rationale is rendered as a code span so links, images, and auto-references are neutralised", () => {
  const c = {
    type: "bug", area: null, priority: "p2", state: "ready-for-agent", route: "none",
    rationale: "See #42 and [click](http://evil) ![img](http://evil.example/x.png) `inject`",
    source: "heuristic", botLabels: ["bug", "p2", "ready-for-agent", "triaged"], pickup_notes: [],
  };
  const comment = renderComment(c, { number: 9 });
  assert.ok(comment.includes("`See #42 and [click](http://evil) ![img](http://evil.example/x.png) 'inject'`"));
});

test("sanitizeRationale collapses newlines and neutralises embedded backticks", () => {
  assert.equal(sanitizeRationale("line one\nline two `x`"), "line one line two 'x'");
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

test("renderPickupPlan lists no pipeline for needs-info or needs-triage/duplicate states", () => {
  const info = renderPickupPlan({ state: "needs-info", route: "none" });
  assert.match(info, /Clarification is needed/);
  assert.doesNotMatch(info, /speckit\./);

  const triage = renderPickupPlan({ state: "needs-triage", route: "none" });
  assert.match(triage, /A human should triage/);
  assert.doesNotMatch(triage, /speckit\./);

  const duplicate = renderPickupPlan({ state: "ready-for-agent", route: "specify", duplicate_of: 5 });
  assert.match(duplicate, /A human should triage/);
  assert.doesNotMatch(duplicate, /speckit\./);
});

test("renderPickupPlan lists the full specify pipeline in order for a ready-for-agent issue", () => {
  const plan = renderPickupPlan({ state: "ready-for-agent", route: "specify" });
  const order = ["/speckit.specify", "/speckit.clarify", "/speckit.plan", "/speckit.tasks", "/speckit.analyze", "/speckit.implement"];
  let lastIndex = -1;
  for (const step of order) {
    const i = plan.indexOf(step);
    assert.ok(i > lastIndex, `${step} should appear after the previous step`);
    lastIndex = i;
  }
  assert.match(plan, /taskstoissues.*optional/i);
});

test("renderPickupPlan names the resolved converge feature directory, or a generic fallback", () => {
  const named = renderPickupPlan({ state: "ready-for-agent", route: "converge" }, "specs/002-issue-triage-automation");
  assert.match(named, /`specs\/002-issue-triage-automation`/);
  assert.match(named, /speckit\.converge/);
  assert.match(named, /speckit\.implement/);

  const fallback = renderPickupPlan({ state: "ready-for-agent", route: "converge" }, null);
  assert.match(fallback, /the relevant existing feature directory/);
});

test("renderPickupPlan gives a one-line pickup hint per type when route is none", () => {
  const cases = [
    ["bug", /failing test/],
    ["documentation", /Edit docs only/],
    ["design", /Pick up directly/],
    ["chore", /Pick up directly/],
    ["spike", /Investigate/],
    ["question", /Answer directly/],
  ];
  for (const [type, phrase] of cases) {
    const plan = renderPickupPlan({ state: "ready-for-agent", route: "none", type });
    assert.match(plan, phrase, `type ${type}`);
    assert.doesNotMatch(plan, /speckit\./, `type ${type} lists no Spec Kit command`);
  }
});

test("renderPickupPlan prefixes the pipeline for ready-for-human but still names the real route", () => {
  const plan = renderPickupPlan({ state: "ready-for-human", route: "specify" });
  assert.match(plan, /After the human decision\/manual work is done/);
  assert.match(plan, /speckit\.specify/);
});

test("renderComment embeds the pickup plan under its own heading", () => {
  const c = { type: "feature", area: null, priority: "p2", state: "ready-for-agent", route: "specify", rationale: "ok", source: "model", botLabels: [], pickup_notes: [] };
  const comment = renderComment(c, { number: 1 });
  assert.match(comment, /## Spec Kit pickup plan/);
  assert.match(comment, /speckit\.specify/);
});

test("renderComment renders pickup_notes as a sanitised bullet list, omitted when empty", () => {
  const withNotes = {
    type: "bug", area: null, priority: "p1", state: "ready-for-agent", route: "specify", rationale: "x",
    source: "model", botLabels: [], pickup_notes: ["Touches #42 and @someone's code `here`"],
  };
  const comment = renderComment(withNotes, { number: 1 });
  assert.match(comment, /Watch for:/);
  assert.match(comment, /`Touches #42 and @someone's code 'here'`/);

  const noNotes = { ...withNotes, pickup_notes: [] };
  assert.doesNotMatch(renderComment(noNotes, { number: 1 }), /Watch for:/);
});
