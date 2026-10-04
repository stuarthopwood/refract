// GraphQL review-thread/timeline/mutation-shape probe (research.md decisions 3 and 4; tasks.md
// T003, issue #182).
//
// Question: what do `reviewThreads` and `timelineItems` connections actually look like on a real
// pull request, what are the exact input fields for `resolveReviewThread`, `unresolveReviewThread`,
// and `addPullRequestReviewComment`, and does the schema expose any dedicated "severity" field for
// an automated reviewer's findings, or is severity only ever a comment-body convention?
//
// FORBIDDEN, no exceptions: this script never executes `resolveReviewThread`,
// `unresolveReviewThread`, or `addPullRequestReviewComment` as a real mutation. The three mutation
// shapes are obtained purely via GraphQL `__type` introspection (zero side effects, read-only).
// Everything else is a plain GraphQL *query* (`reviewThreads`, `timelineItems`, and `__type`
// introspection on `PullRequestReviewThread`/`PullRequestReviewComment`/the timeline item-type
// enum) against a real, already public pull request. Nothing is created, commented on, resolved,
// unresolved, labelled, merged, or closed.
//
// GitHub's GraphQL endpoint allows each `__Type.inputFields`/`fields`/`enumValues` introspection
// field at most twice per single request, so each introspection below is its own request.
//
// Run:  node docs/spike/gh-pr-graphql-probe.mjs
// Env:  REFRACT_PROBE_REPO  owner/repo to probe (default stuarthopwood/refract)
//       REFRACT_PROBE_PR    PR number to probe reviewThreads/timelineItems on (default 95)
//
// Prints one JSON summary to stdout and writes the full raw `gh api graphql` output next to it in
// a temp scratch dir (printed at the end).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = process.env.REFRACT_PROBE_REPO || "stuarthopwood/refract";
const [OWNER, NAME] = REPO.split("/");
const PR = process.env.REFRACT_PROBE_PR || "95";
const ROOT = path.join(os.tmpdir(), "pinion-gh-pr-graphql-probe", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(ROOT, { recursive: true });

function graphql(label, query, extraArgs = []) {
  const args = ["api", "graphql", "-f", `query=${query}`, ...extraArgs];
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });
    fs.writeFileSync(path.join(ROOT, `${label}.json`), out);
    return { ok: true, data: JSON.parse(out) };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    fs.writeFileSync(path.join(ROOT, `${label}.err.txt`), out || String(e));
    return { ok: false, error: (e.stderr || e.message || String(e)).trim() };
  }
}

function fieldNamesOf(data, key) {
  if (!data || !data.data || !data.data.__type) return null;
  const t = data.data.__type;
  const list = t.inputFields || t.fields || null;
  return list ? list.map((f) => f.name) : t.enumValues ? t.enumValues.map((e) => e.name) : null;
}

const results = { repo: REPO, pr: PR, scratch: ROOT };

// --- Mutation input shapes: introspection only, never a real mutation call. ---
const resolveInput = graphql(
  "introspect-resolve-input",
  '{ __type(name: "ResolveReviewThreadInput") { inputFields { name type { kind name ofType { name kind } } } } }',
);
results.resolveReviewThreadInput = { ok: resolveInput.ok, fieldNames: fieldNamesOf(resolveInput.data) };

const unresolveInput = graphql(
  "introspect-unresolve-input",
  '{ __type(name: "UnresolveReviewThreadInput") { inputFields { name type { kind name ofType { name kind } } } } }',
);
results.unresolveReviewThreadInput = { ok: unresolveInput.ok, fieldNames: fieldNamesOf(unresolveInput.data) };

const addCommentInput = graphql(
  "introspect-add-comment-input",
  '{ __type(name: "AddPullRequestReviewCommentInput") { inputFields { name type { kind name ofType { name kind } } } } }',
);
results.addPullRequestReviewCommentInput = { ok: addCommentInput.ok, fieldNames: fieldNamesOf(addCommentInput.data) };

// --- Object/enum shapes, to see whether a dedicated severity field exists anywhere near a
// review thread or review comment (it does not, per the live schema; severity is a comment-body
// convention if present at all -- confirms research.md decision 4's 'unknown' fallback). ---
const threadFields = graphql(
  "introspect-thread-fields",
  '{ __type(name: "PullRequestReviewThread") { fields { name type { kind name ofType { name kind } } } } }',
);
results.pullRequestReviewThreadFields = { ok: threadFields.ok, fieldNames: fieldNamesOf(threadFields.data) };

const commentFields = graphql(
  "introspect-comment-fields",
  '{ __type(name: "PullRequestReviewComment") { fields { name type { kind name ofType { name kind } } } } }',
);
results.pullRequestReviewCommentFields = { ok: commentFields.ok, fieldNames: fieldNamesOf(commentFields.data) };
results.pullRequestReviewCommentHasSeverityField = results.pullRequestReviewCommentFields.fieldNames
  ? results.pullRequestReviewCommentFields.fieldNames.some((n) => /severity/i.test(n))
  : null;

const itemTypeEnum = graphql(
  "introspect-timeline-item-type",
  '{ __type(name: "PullRequestTimelineItemsItemType") { enumValues { name } } }',
);
results.timelineItemsItemType = { ok: itemTypeEnum.ok, values: fieldNamesOf(itemTypeEnum.data) };

// --- Live reviewThreads + timelineItems query against a real pull request. ---
const live = graphql(
  "live-reviewthreads-timeline",
  `query { repository(owner: "${OWNER}", name: "${NAME}") { pullRequest(number: ${PR}) { ` +
    "reviewThreads(first: 10) { totalCount nodes { id isResolved isOutdated path line diffSide " +
    "comments(first: 5) { totalCount nodes { author { login } body createdAt } } } } " +
    "timelineItems(first: 30) { totalCount nodes { __typename " +
    "... on PullRequestReview { state author { login } body } " +
    "... on PullRequestCommit { commit { oid } } " +
    "... on IssueComment { author { login } } } } } } }",
);
if (live.ok) {
  const pr = live.data.data.repository.pullRequest;
  results.liveReviewThreads = { totalCount: pr.reviewThreads.totalCount, nodes: pr.reviewThreads.nodes };
  results.liveTimelineItems = {
    totalCount: pr.timelineItems.totalCount,
    typenamesInOrder: pr.timelineItems.nodes.map((n) => n.__typename),
  };
  // Any review whose author login looks like an automated reviewer (Copilot or similar bot) --
  // none were found against this repo's real PRs, recorded as such rather than fabricated.
  const reviewNodes = pr.timelineItems.nodes.filter((n) => n.__typename === "PullRequestReview");
  results.automatedReviewsObserved = reviewNodes.filter((n) => /copilot|\[bot\]/i.test(n.author?.login || ""));
} else {
  results.liveQueryError = live.error;
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (full raw gh api graphql output): ${ROOT}`);
