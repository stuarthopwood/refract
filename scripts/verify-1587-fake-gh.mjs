// Fake `gh` for verify-1587-session-pr-badge.mjs: only the two GraphQL reads the header badge makes.
// REFRACT_1587_MODE=badge -> the branch has no PR; =overflow -> it has PR #5. Reuses the #1121 launcher shim.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGIC = `'use strict';
const args = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const kv = {};
for (const a of args) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1); }
const joined = args.join(' ');
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('headRefName')) {
  const nodes = process.env.REFRACT_1587_MODE === 'overflow'
    ? [{ number: 5, url: 'https://github.com/fake-owner/fake-repo-1121/pull/5', state: 'OPEN', isDraft: false, commits: { nodes: [] }, closingIssuesReferences: { nodes: [] } }]
    : [];
  out({ data: { repository: { pullRequests: { nodes } } } });
}
if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('issueOrPullRequest')) {
  const known = {
    'fake-owner/fake-repo-1121#5': ['PullRequest', 'Badge fixture pull request', 'pull/5'],
    'fake-owner/fake-repo-1121#12': ['Issue', 'Badge fixture issue', 'issues/12'],
    'other-owner/other-repo#7': ['PullRequest', 'Foreign repo pull request', 'pull/7']
  };
  const hit = known[kv.owner + '/' + kv.name + '#' + kv.number];
  if (!hit) out({ data: { repository: { issueOrPullRequest: null } } });
  out({ data: { repository: { issueOrPullRequest: { __typename: hit[0], title: hit[1], url: 'https://github.com/' + kv.owner + '/' + kv.name + '/' + hit[2], state: 'OPEN', isDraft: false } } } });
}
process.stderr.write('fake gh 1587: unhandled: gh ' + joined + '\\n');
process.exit(1);
`;

/** Compiles the `gh.exe` launcher and writes the logic beside it; returns the dir to put on PATH. */
export function buildFakeGh1587(destDir) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(path.join(destDir, 'fake-gh-logic.cjs'), LOGIC);
  const result = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-1121-fake-gh-launcher.rs'), '-o', path.join(destDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`buildFakeGh1587: rustc failed:\n${result.stderr}`);
  return destDir;
}
