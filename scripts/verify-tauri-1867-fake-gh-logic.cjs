// Fake `gh` for verify-tauri-1867.mjs, run by the compiled launcher (verify-1121-fake-gh-launcher.rs) as
// `fake-gh-logic.cjs` beside it. Serves a 3-layer stack (#1 -> #2 -> #3 on main) plus plain #4, records
// every argv to gh-calls.log, and is steered by control files next to it: `stack-version` ("0.3.0",
// "old" or "missing") and `exit9` (makes `gh stack merge` exit 9). Never talks to GitHub.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'gh-calls.log'), `${args.join(' ')}\n`);
const control = (name) => path.join(dir, name);
const emit = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

const AUTHOR = { login: 'octocat', name: 'The Octocat' };
const PRS = [
  { number: 1, title: 'Layer 1: add the parser', head: 'feature-1', base: 'main' },
  { number: 2, title: 'Layer 2: wire the parser in', head: 'feature-2', base: 'feature-1' },
  { number: 3, title: 'Layer 3: document the parser', head: 'feature-3', base: 'feature-2' },
  { number: 4, title: 'Plain: fix a typo', head: 'feature-4', base: 'main' }
];

function listEntry(pr) {
  return {
    number: pr.number, title: pr.title, state: 'OPEN', isDraft: false, author: AUTHOR,
    headRefName: pr.head, baseRefName: pr.base, updatedAt: '2026-10-21T12:00:00.000Z',
    statusCheckRollup: null, labels: [], reviewRequests: [], assignees: []
  };
}

function viewDetail(pr) {
  return {
    ...listEntry(pr),
    commits: [{ oid: `sha-${pr.number}`, messageHeadline: `Commit for #${pr.number}` }],
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', additions: 10, deletions: 2, changedFiles: 1,
    files: [{ path: 'file.txt', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
    id: `PR_${pr.number}`, headRefOid: `head-${pr.number}`, body: `Description for pull request #${pr.number}.`,
    isCrossRepository: false, headRepositoryOwner: null
  };
}

const [a, b] = args;
if (a === 'stack' && b === '--version') {
  const version = fs.existsSync(control('stack-version')) ? fs.readFileSync(control('stack-version'), 'utf8').trim() : '0.3.0';
  if (version === 'missing') fail('unknown command "stack" for "gh"');
  if (version === 'old') fail('unknown flag: --version');
  process.stdout.write(`gh stack version ${version}\n`);
} else if (a === 'extension' && (b === 'install' || b === 'upgrade')) {
  fs.writeFileSync(control('stack-version'), '0.3.0');
  process.stdout.write('installed\n');
} else if (a === 'stack' && b === 'view') {
  const branch = args[args.length - 1];
  if (!PRS.slice(0, 3).some((pr) => pr.head === branch)) fail('not in a stack', 2);
  emit({
    trunk: 'main', currentBranch: branch,
    branches: PRS.slice(0, 3).map((pr) => ({ name: pr.head, head: `head-${pr.number}`, base: pr.base, isMerged: false, pr: { number: pr.number, state: 'OPEN' } }))
  });
} else if (a === 'stack' && b === 'merge') {
  if (fs.existsSync(control('exit9'))) fail('stacks unavailable', 9);
  process.stdout.write('merged\n');
} else if (a === 'pr' && b === 'merge') {
  process.stdout.write('merged\n');
} else if (a === 'pr' && b === 'list') {
  emit(PRS.map(listEntry));
} else if (a === 'search' && b === 'prs') {
  emit(PRS.map((pr) => ({ ...listEntry(pr), state: 'open', url: `https://github.com/fake-owner/fake-repo-1121/pull/${pr.number}`, repository: { nameWithOwner: 'fake-owner/fake-repo-1121', name: 'fake-repo-1121' } })));
} else if (a === 'pr' && b === 'view') {
  const pr = PRS.find((p) => p.number === Number(args[2]));
  if (!pr) fail(`fake gh: no pull request ${args[2]}`);
  emit(viewDetail(pr));
} else if (a === 'api' && typeof b === 'string' && b.includes('/stacks')) {
  fail('gh: Not Found (HTTP 404)');
} else if (a === 'api' && b === 'graphql') {
  emit({ data: { repository: { pullRequest: { id: 'PR_fixture', reviewThreads: { nodes: [] }, timelineItems: { nodes: [] } } } } });
} else if (a === 'api' && typeof b === 'string' && b.startsWith('repos/') && b.includes('/files')) {
  emit([]);
} else if (a === 'repo' && b === 'view') {
  emit({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true });
} else {
  fail(`fake gh: unhandled command: gh ${args.join(' ')}`);
}
