// Pull request list/filter data probe (research.md decision 3, row 1; tasks.md T001, issue #175).
//
// Question: what are the exact `--json` field names `gh pr list` returns, and which `gh search
// prs` qualifiers reproduce each of the four non-Open filter tabs (spec 003's "Created by me",
// "Assigned to me", "Mentions me"/"Involves me", "Review requests")?
//
// READ-ONLY: every call below is a `gh pr list` or `gh search prs` read against a real, already
// public repository. Nothing is created, commented on, labelled, merged, or closed.
//
// Run:  node docs/spike/gh-pr-list-probe.mjs
// Env:  REFRACT_PROBE_REPO  owner/repo to probe (default stuarthopwood/refract)
//
// Prints one JSON summary to stdout and writes the full raw `gh` output next to it in a temp
// scratch dir (printed at the end); this repo only gets the summarised field names and counts
// recorded by hand into docs/spike/FINDINGS.md and research.md, never the raw PR titles/bodies.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = process.env.REFRACT_PROBE_REPO || "stuarthopwood/refract";
const ROOT = path.join(os.tmpdir(), "pinion-gh-pr-list-probe", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(ROOT, { recursive: true });

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });
}

function tryGh(label, args) {
  try {
    const out = gh(args);
    fs.writeFileSync(path.join(ROOT, `${label}.json`), out);
    return { ok: true, data: JSON.parse(out) };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    fs.writeFileSync(path.join(ROOT, `${label}.err.txt`), out || String(e));
    return { ok: false, error: (e.stderr || e.message || String(e)).trim() };
  }
}

const LIST_FIELDS = [
  "number", "title", "state", "isDraft", "author", "headRefName", "baseRefName",
  "updatedAt", "statusCheckRollup", "labels", "reviewRequests", "assignees",
].join(",");

const results = { repo: REPO, scratch: ROOT };

// 1. The porcelain `gh pr list --json` surface (the "Open" tab plus the row-rendering fields).
const list = tryGh("pr-list", ["pr", "list", "--repo", REPO, "--state", "all", "--limit", "50", "--json", LIST_FIELDS]);
results.prList = list.ok
  ? { ok: true, count: list.data.length, fieldNames: list.data[0] ? Object.keys(list.data[0]) : LIST_FIELDS.split(",") }
  : { ok: false, error: list.error };

// 2. The four non-Open filter tabs, each via a `gh search prs` qualifier against the same repo.
// `gh search prs` runs against the GitHub search index, not the `pr list` porcelain endpoint, so
// its own --json field names are checked separately (they differ: no statusCheckRollup/labels
// objects, see "search prs --help").
const TABS = [
  { tab: "Created by me", qualifier: "author:@me" },
  { tab: "Assigned to me", qualifier: "assignee:@me" },
  { tab: "Mentions me", qualifier: "involves:@me" },
  { tab: "Review requests", qualifier: "review-requested:@me" },
];
results.searchTabs = TABS.map(({ tab, qualifier }) => {
  const label = `search-${qualifier.replace(/[^a-z-]/gi, "_")}`;
  const r = tryGh(label, ["search", "prs", "--repo", REPO, qualifier, "--json", "number,title,state,author"]);
  return r.ok
    ? { tab, qualifier, ok: true, count: r.data.length, fieldNames: r.data[0] ? Object.keys(r.data[0]) : null }
    : { tab, qualifier, ok: false, error: r.error };
});

// 3. `gh search prs --help`'s own documented --json field list, for the fields this account's
// `gh` version actually supports on the search surface (distinct from `gh pr list --json`'s list,
// confirmed by diffing the two field sets by hand when writing FINDINGS.md).
try {
  const help = execFileSync("gh", ["search", "prs", "--help"], { encoding: "utf8", timeout: 15_000 });
  const m = help.match(/JSON FIELDS\n([\s\S]*?)\n\n/);
  results.searchPrsJsonFields = m ? m[1].replace(/\s+/g, " ").trim() : null;
} catch (e) {
  results.searchPrsJsonFields = null;
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (full raw gh output): ${ROOT}`);
