// Pull request detail/Overview/Changes data probe (research.md decisions 3 and 5; tasks.md
// T002, issue #178).
//
// Question: what are the exact `--json` field names `gh pr view` returns for the Overview tab
// (title/state/branches/reviews/labels/body/commits), for mergeability (`mergeable`,
// `mergeStateStatus`), and for changed files -- and does the porcelain `files` field ever carry a
// diff `patch`, or is `patch` only reachable through the REST endpoint directly?
//
// READ-ONLY: every call is a `gh pr view`/`gh api` GET against a real, already public pull
// request. Nothing is created, commented on, labelled, merged, or closed.
//
// Run:  node docs/spike/gh-pr-view-probe.mjs
// Env:  REFRACT_PROBE_REPO  owner/repo to probe (default stuarthopwood/refract)
//       REFRACT_PROBE_PRS   comma-separated PR numbers to probe (default 95,96)
//
// Prints one JSON summary to stdout and writes the full raw `gh`/`gh api` output next to it in a
// temp scratch dir (printed at the end); FINDINGS.md and research.md only get the summarised
// field names, not the raw PR bodies.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = process.env.REFRACT_PROBE_REPO || "stuarthopwood/refract";
const PRS = (process.env.REFRACT_PROBE_PRS || "95,96").split(",").map((s) => s.trim());
const ROOT = path.join(os.tmpdir(), "pinion-gh-pr-view-probe", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(ROOT, { recursive: true });

function tryGh(label, args) {
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

const VIEW_FIELDS = [
  "title", "number", "state", "baseRefName", "headRefName", "reviews", "reviewRequests",
  "assignees", "labels", "commits", "mergeStateStatus", "mergeable", "additions", "deletions",
  "changedFiles", "files",
].join(",");

const results = { repo: REPO, scratch: ROOT, prs: {} };

for (const n of PRS) {
  const view = tryGh(`pr-${n}-view`, ["pr", "view", n, "--repo", REPO, "--json", VIEW_FIELDS]);
  const entry = { ok: view.ok };
  if (view.ok) {
    const d = view.data;
    entry.fieldNames = Object.keys(d);
    entry.mergeable = d.mergeable;
    entry.mergeStateStatus = d.mergeStateStatus;
    entry.changedFiles = d.changedFiles;
    // The porcelain `files` array's own per-entry field names -- confirmed to never include
    // `patch`, even for a one-line diff (see REST comparison below).
    entry.filesEntryFieldNames = d.files && d.files[0] ? Object.keys(d.files[0]) : d.files;
    entry.reviewsCount = Array.isArray(d.reviews) ? d.reviews.length : null;
    entry.commitsCount = Array.isArray(d.commits) ? d.commits.length : null;
  } else {
    entry.error = view.error;
  }

  // The REST "list pull request files" endpoint, for comparison: does *it* carry `patch` for the
  // same file the porcelain `files` field just reported with no `patch` key at all?
  const rest = tryGh(`pr-${n}-rest-files`, ["api", `repos/${REPO}/pulls/${n}/files`]);
  if (rest.ok) {
    entry.restFilesEntryFieldNames = rest.data[0] ? Object.keys(rest.data[0]) : rest.data;
    entry.restFilesHavePatchKey = rest.data.every((f) => "patch" in f);
  } else {
    entry.restFilesError = rest.error;
  }

  results.prs[n] = entry;
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (full raw gh/gh api output): ${ROOT}`);
