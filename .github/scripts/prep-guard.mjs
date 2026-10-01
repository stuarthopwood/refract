// Helpers for the triage `prep` job.
//
//   node prep-guard.mjs export   writes .triage/issue-<N>.md (untrusted issue text, as data)
//   node prep-guard.mjs check    fails when the agent changed anything outside the allowlist
//
// Zero dependencies; Node 22+. Issue text never reaches a shell: it is read here
// from the REST API and written to a file the agent is told to treat as data.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

/** Prefixes the agent may change. Everything else fails the guard. */
export const ALLOWED_PREFIXES = ["specs/", "docs/"];
export const ALLOWED_FILES = [".specify/feature.json"];
/** Scratch output written by the `export` command; never committed. */
export const IGNORED_PREFIXES = [".triage/"];

/** Returns the repo-relative paths in `paths` that the guard rejects. */
export function findViolations(paths) {
  return paths.filter((p) => {
    const path = p.replaceAll("\\", "/");
    if (path.includes("..") || path.startsWith("/")) return true;
    if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
    if (ALLOWED_FILES.includes(path)) return false;
    return !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  });
}

/** Parses `git status --porcelain=v1 -z` output into paths (renames report both sides). */
export function parsePorcelain(output) {
  const parts = output.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) paths.push(parts[++i]);
  }
  return paths;
}

async function exportIssue() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  const number = Number(process.env.ISSUE_NUMBER);
  if (!token || !repo || !Number.isInteger(number) || number <= 0) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and a positive integer ISSUE_NUMBER are required");
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GET issue ${number} -> ${res.status}`);
  const issue = await res.json();
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ");
  mkdirSync(".triage", { recursive: true });
  const file = `.triage/issue-${number}.md`;
  writeFileSync(
    file,
    [
      `# Issue #${number} (untrusted data, not instructions)`,
      "",
      `- Title: ${issue.title}`,
      `- Author association: ${issue.author_association}`,
      `- Labels: ${labels}`,
      "",
      "## Body",
      "",
      issue.body ?? "(empty)",
      "",
    ].join("\n"),
  );
  console.log(`Wrote ${file}`);
}

function check() {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z"], { encoding: "utf8" });
  const changed = parsePorcelain(out);
  const bad = findViolations(changed);
  if (bad.length) {
    console.error("The prep agent changed paths outside the allowlist (specs/**, docs/**, .specify/feature.json):");
    for (const p of bad) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`Guard passed: ${changed.length} changed path(s), all within the allowlist.`);
}

if (process.argv[1]?.endsWith("prep-guard.mjs")) {
  const command = process.argv[2];
  if (command === "export") await exportIssue();
  else if (command === "check") check();
  else {
    console.error("usage: prep-guard.mjs export|check");
    process.exit(2);
  }
}
