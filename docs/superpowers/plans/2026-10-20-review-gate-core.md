# Risk-tiered review gate (core) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user-level core of the risk-tiered review gate — two deterministic Node scripts, seven new panel agents, a patch to four existing specialist agents, the orchestrating skill, Claude Code mirrors of all of the above, and the routing switch that lets a repository opt in via `.github/review-gate.json`.

**Architecture:** Two small, dependency-free Node scripts (`floor.mjs`, `check-record.mjs`) compute and later re-verify a mechanical "rule floor" from the diff and repository config. A new `review-gate` skill orchestrates the 11-step pipeline (preflight → classify → review rounds → adjudicate → verify ACs → converge → escalate → exhaust → record → merge) by spawning seven new OMP/Claude agents — one independent classifier, four voting panel roles, one non-voting Trivial-tier generalist, and one refuter — plus the four existing specialist agents (now patched to support diff-scoped, config-driven operation). Everything lives at user level, each with a Claude Code mirror, beside today's `quality-gate` skill and reviewer agents.

**Tech Stack:** Node 20+ (built-in modules only) for the scripts, `node:test` for their unit tests, Markdown + YAML frontmatter for the agents and skill, `gh` CLI for GitHub interaction.

## Global Constraints

- Scripts target Node 20 or later, built-in modules only — no npm dependency.
- `scripts/review-gate/floor.mjs` first line: `// review-gate floor v1.0.0`.
- `scripts/review-gate/check-record.mjs` first line: `// review-gate check-record v1.0.0`.
- Config file path: `.github/review-gate.json` (schema version `1`).
- Gate-record sticky PR comment marker: `<!-- review-gate-record v1 -->`, one fenced ```json block, trusted only when `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.
- Human-approval label: `review-gate:human-approved`.
- Repo config key `humanApproval`: `"label"` (default) or `"required-review"` — `check-record.mjs` passes a `NEEDS_HUMAN` verdict without the label when the repo uses `"required-review"` (branch protection owns that approval instead).
- Enforcement invariant: the CI record check runs from a **base-ref checkout** (`pull_request_target` gives this by default) and diffs the PR head via a fetched ref, never by checking out or executing PR-head code. The core scripts and skill must not assume `.github/review-gate.json` or the vendored scripts come from the PR head. Wiring the actual CI workflow YAML is Refract-adoption work (out of scope here) — this plan's job is to not violate the invariant.
- This core is NOT inside the Refract repo, so Refract's no-new-tests rule does not apply: `floor.mjs` and `check-record.mjs` get real `node:test` suites.
- Agents: `~/.omp/agent/agents/gate-{classifier,generalist,spec-keeper,adversary,maintainer,operator,refuter}.md`, mirrored at `~/.claude/agents/gate-*.md`.
- Skill: `~/.omp/agent/skills/review-gate/SKILL.md`, canonical scripts at `~/.omp/agent/skills/review-gate/scripts/{floor,check-record}.mjs` with sibling `*.test.mjs` files, mirrored at `~/.claude/skills/review-gate/`.
- Panel findings format (binding, from the design's Pipeline section): `` **[SEVERITY]** path:line — description `` plus a vote of `APPROVE`, `APPROVE_WITH_NITS`, or `REQUEST_CHANGES`. Severities: `Low`, `Medium`, `High`, `Critical`.
- Reviewers (classifier, panel, refuter) receive exactly: the diff, the direct callers/callees of anything it touches, the ACs, the repository policy, and the previous round's findings. They never receive the implementer's commit messages, PR description, or any other narrative account of intent.

## Not in this plan

- Refract adoption: its own Refract issue, `grill-with-docs` pass, and Spec Kit run to add Refract's `.github/review-gate.json`, the vendored `scripts/review-gate/` copies, and the `pull_request_target` CI workflow, then cut Refract over.
- The app-wide audit job (its own job/PR type, out of scope until a repo has adopted the gate).
- The RepeatPlus / fdb-agentkit port and its required shadow run.
- Installing or configuring the Claude/Copilot bots (Refract's trial runs with none; this is a per-repo `bots` config entry at adoption time).

## File structure

**Create:**
- `~/.omp/agent/skills/review-gate/scripts/floor.mjs` — rule-floor computation, CLI + pure functions.
- `~/.omp/agent/skills/review-gate/scripts/floor.test.mjs` — `node:test` suite for the pure functions.
- `~/.omp/agent/skills/review-gate/scripts/check-record.mjs` — CI record-check, CLI + pure functions.
- `~/.omp/agent/skills/review-gate/scripts/check-record.test.mjs` — `node:test` suite for the pure functions.
- `~/.omp/agent/agents/gate-classifier.md`, `gate-generalist.md`, `gate-spec-keeper.md`, `gate-adversary.md`, `gate-maintainer.md`, `gate-operator.md`, `gate-refuter.md` — the seven new agents.
- `~/.omp/agent/skills/review-gate/SKILL.md` — the orchestrating skill.
- `~/.claude/agents/gate-classifier.md` … `gate-refuter.md` — Claude Code mirrors of the seven agents.
- `~/.claude/skills/review-gate/SKILL.md` + `scripts/{floor,check-record}.{mjs,test.mjs}` — Claude Code mirror of the skill and scripts.

**Modify:**
- `~/.omp/agent/agents/security-auditor.md`, `accessibility-auditor.md`, `performance-optimiser.md`, `test-reviewer.md` — add a "Review-gate mode" section.
- `~/.claude/agents/security-auditor.md`, `accessibility-auditor.md`, `performance-optimiser.md`, `test-reviewer.md` — same addition.
- `~/.omp/agent/AGENTS.md` — route the Quality gate HARD RULE by config presence.
- `~/.omp/agent/managed-skills/quality-gate/SKILL.md` — same routing note at the top.

---

### Task 1: Rule-floor script (`floor.mjs`)

**Files:**
- Create: `~/.omp/agent/skills/review-gate/scripts/floor.mjs`
- Create: `~/.omp/agent/skills/review-gate/scripts/floor.test.mjs`

**Interfaces:**
- Produces (used by Task 2 and the skill): `RISK_ORDER`, `SECURITY_ORDER` (string arrays, lowest-to-highest), `DEFAULT_CONFIG` (object), `loadConfig(configPath: string): object`, `changedFiles(base: string, head: string): string[]`, `countChangedLines(base: string, head: string): number`, `computeFloor(files: string[], config: object, changedLines: number): { risk, security, areas, humanRequired: {category, paths}[], changedLines, splitRecommended }`, `globToRegExp(glob: string): RegExp`.
- CLI: `node scripts/review-gate/floor.mjs --base <ref> [--head <ref>] [--config <path>]` → stdout JSON matching `computeFloor`'s return shape, exit 0.

- [ ] **Step 1: Write the implementation**

```javascript
// review-gate floor v1.0.0
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RISK_ORDER = ['Trivial', 'Standard', 'Elevated', 'Severe'];
export const SECURITY_ORDER = ['None', 'Contained', 'Sensitive', 'Severe'];

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  preflight: [],
  pathRules: [],
  sizeRules: { standardAboveLines: 150, elevatedAboveLines: 400, splitAboveLines: 800 },
  humanRequiredAdd: [],
  acSource: { kind: 'spec-md', path: 'specs' },
  evidenceKinds: [],
  testPolicy: 'tests-expected',
  bots: [],
  humanApproval: 'label',
  mergeAuthority: {},
  auditEveryMerges: 10,
  auditMarker: 'docs/audit/last-app-wide.md',
};

const CORE_RULES = [
  { category: 'ci', glob: '.github/**' },
  { category: 'migration', glob: '**/migrations/**' },
  { category: 'gate-self', glob: 'scripts/review-gate/**' },
];

const DEPENDENCY_MANIFEST_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'npm-shrinkwrap.json', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Gemfile.lock',
]);

/** Convert a repository-config glob (`**`, `*`, literal segments) into a RegExp. No dependency, built-in only. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++; // consume second '*'
      if (glob[i + 1] === '/') {
        i++; // consume the slash too
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function higher(order, a, b) {
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function mergeConfig(userConfig) {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    sizeRules: { ...DEFAULT_CONFIG.sizeRules, ...(userConfig.sizeRules || {}) },
    acSource: { ...DEFAULT_CONFIG.acSource, ...(userConfig.acSource || {}) },
  };
}

export function loadConfig(configPath) {
  if (!existsSync(configPath)) return mergeConfig({});
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return mergeConfig(raw);
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

export function changedFiles(base, head) {
  const out = runGit(['diff', '--name-only', `${base}...${head}`]);
  return out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

export function countChangedLines(base, head) {
  const out = runGit(['diff', '--numstat', `${base}...${head}`]);
  let total = 0;
  for (const line of out.split('\n').filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    if (added !== '-') total += Number(added);
    if (deleted !== '-') total += Number(deleted);
  }
  return total;
}

/** Pure function: given changed files + config, compute the rule-floor rating. No git, no fs — unit-testable in isolation. */
export function computeFloor(files, config, changedLines) {
  let risk = 'Trivial';
  let security = 'None';
  const areas = [];
  const humanRequiredPaths = new Map(); // category -> Set<path>

  const addHumanRequired = (category, path) => {
    if (!humanRequiredPaths.has(category)) humanRequiredPaths.set(category, new Set());
    humanRequiredPaths.get(category).add(path);
  };

  const rules = [
    ...CORE_RULES,
    ...(config.pathRules || []),
    ...(config.humanRequiredAdd || []),
  ];

  for (const file of files) {
    if (DEPENDENCY_MANIFEST_BASENAMES.has(basename(file))) {
      addHumanRequired('dependency-manifest', file);
    }
    for (const rule of rules) {
      if (!rule.glob) continue;
      if (!globToRegExp(rule.glob).test(file)) continue;
      if (rule.area && !areas.includes(rule.area)) areas.push(rule.area);
      if (rule.minRisk) risk = higher(RISK_ORDER, risk, rule.minRisk);
      if (rule.minSecurity) security = higher(SECURITY_ORDER, security, rule.minSecurity);
      if (rule.category) addHumanRequired(rule.category, file);
      if (rule.humanRequired) addHumanRequired(rule.humanRequired, file);
    }
  }

  if (changedLines > config.sizeRules.elevatedAboveLines) risk = higher(RISK_ORDER, risk, 'Elevated');
  else if (changedLines > config.sizeRules.standardAboveLines) risk = higher(RISK_ORDER, risk, 'Standard');

  const humanRequired = [...humanRequiredPaths.entries()]
    .map(([category, paths]) => ({ category, paths: [...paths].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const splitRecommended = changedLines > config.sizeRules.splitAboveLines;

  return { risk, security, areas, humanRequired, changedLines, splitRecommended };
}

function parseArgs(argv) {
  const args = { config: '.github/review-gate.json', head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--head') args.head = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
  }
  if (!args.base) throw new Error('--base <ref> is required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const files = changedFiles(args.base, args.head);
  const changedLines = countChangedLines(args.base, args.head);
  const result = computeFloor(files, config, changedLines);
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 2: Write the test suite**

```javascript
// review-gate floor v1.0.0 tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, computeFloor, DEFAULT_CONFIG } from './floor.mjs';

test('globToRegExp matches a trailing ** against nested paths', () => {
  const re = globToRegExp('src-tauri/src/auth/**');
  assert.ok(re.test('src-tauri/src/auth/login.ts'));
  assert.ok(re.test('src-tauri/src/auth/sub/deep.ts'));
  assert.ok(!re.test('src-tauri/src/other/login.ts'));
});

test('globToRegExp matches a leading **/ against any depth', () => {
  const re = globToRegExp('**/migrations/**');
  assert.ok(re.test('migrations/001_init.sql'));
  assert.ok(re.test('db/migrations/001_init.sql'));
  assert.ok(re.test('packages/api/db/migrations/nested/002.sql'));
  assert.ok(!re.test('src/migrations_helper.ts'));
});

test('computeFloor stays Trivial with no matches and a small diff', () => {
  const result = computeFloor(['README.md'], DEFAULT_CONFIG, 5);
  assert.equal(result.risk, 'Trivial');
  assert.equal(result.security, 'None');
  assert.deepEqual(result.areas, []);
  assert.deepEqual(result.humanRequired, []);
  assert.equal(result.splitRecommended, false);
});

test('computeFloor raises risk from size thresholds, never lowers below a path-rule floor', () => {
  const config = {
    ...DEFAULT_CONFIG,
    pathRules: [{ glob: 'src/payments/**', area: 'backend', minRisk: 'Elevated', minSecurity: 'Sensitive' }],
  };
  const result = computeFloor(['src/payments/charge.ts'], config, 10);
  assert.equal(result.risk, 'Elevated');
  assert.equal(result.security, 'Sensitive');
  assert.deepEqual(result.areas, ['backend']);
});

test('computeFloor combines a path-rule floor with a higher size-driven floor', () => {
  const config = {
    ...DEFAULT_CONFIG,
    pathRules: [{ glob: 'src/payments/**', minRisk: 'Standard' }],
  };
  const result = computeFloor(['src/payments/charge.ts'], config, 500);
  assert.equal(result.risk, 'Elevated'); // 500 > elevatedAboveLines(400) beats the rule's Standard
});

test('computeFloor flags core human-required categories: ci, migration, dependency-manifest, gate-self', () => {
  const files = [
    '.github/workflows/ci.yml',
    'db/migrations/003_add_table.sql',
    'package-lock.json',
    'scripts/review-gate/floor.mjs',
  ];
  const result = computeFloor(files, DEFAULT_CONFIG, 20);
  const byCategory = Object.fromEntries(result.humanRequired.map((h) => [h.category, h.paths]));
  assert.deepEqual(byCategory.ci, ['.github/workflows/ci.yml']);
  assert.deepEqual(byCategory.migration, ['db/migrations/003_add_table.sql']);
  assert.deepEqual(byCategory['dependency-manifest'], ['package-lock.json']);
  assert.deepEqual(byCategory['gate-self'], ['scripts/review-gate/floor.mjs']);
});

test('computeFloor applies a repository pathRule humanRequired category (e.g. auth)', () => {
  const config = {
    ...DEFAULT_CONFIG,
    pathRules: [{ glob: 'src-tauri/src/auth/**', area: 'backend', minRisk: 'Elevated', minSecurity: 'Sensitive', humanRequired: 'auth' }],
  };
  const result = computeFloor(['src-tauri/src/auth/login.rs'], config, 30);
  assert.deepEqual(result.humanRequired, [{ category: 'auth', paths: ['src-tauri/src/auth/login.rs'] }]);
});

test('computeFloor recommends a split above the configured line threshold', () => {
  const result = computeFloor(['src/x.ts'], DEFAULT_CONFIG, 801);
  assert.equal(result.splitRecommended, true);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test ~/.omp/agent/skills/review-gate/scripts/floor.test.mjs`
Expected: `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0` (verified: this exact suite passes 8/8 against the implementation above).

- [ ] **Step 4: Smoke-test the CLI end to end**

In a scratch git repo with a `.github/review-gate.json` containing a `src/payments/**` rule (`minRisk: Elevated`, `minSecurity: Sensitive`, `humanRequired: auth`) and `sizeRules.elevatedAboveLines: 20`, commit a change touching `.github/workflows/ci.yml` and `src/payments/charge.ts`, then run:

```bash
node scripts/review-gate/floor.mjs --base <base-tag> --head HEAD --config .github/review-gate.json
```

Expected (verified against this exact implementation):
```json
{"risk":"Elevated","security":"Sensitive","areas":["backend"],"humanRequired":[{"category":"auth","paths":["src/payments/charge.ts"]},{"category":"ci","paths":[".github/review-gate.json",".github/workflows/ci.yml"]}],"changedLines":11,"splitRecommended":false}
```

- [ ] **Step 5: Commit**

```bash
git add scripts/review-gate/floor.mjs scripts/review-gate/floor.test.mjs
git commit -m "feat(review-gate): add rule-floor script with tests"
```

---

### Task 2: Record-check script (`check-record.mjs`)

**Files:**
- Create: `~/.omp/agent/skills/review-gate/scripts/check-record.mjs`
- Create: `~/.omp/agent/skills/review-gate/scripts/check-record.test.mjs`

**Interfaces:**
- Consumes (from Task 1): `RISK_ORDER`, `SECURITY_ORDER`, `computeFloor`, `loadConfig`, `changedFiles`, `countChangedLines` — all from `./floor.mjs`.
- Produces (used by the skill and by each repository's CI workflow): `MARKER` (string), `TRUSTED_ASSOCIATIONS` (Set), `HUMAN_APPROVED_LABEL` (string), `extractRecordJson(commentBody: string): object | null`, `findRecordComment(comments: object[]): object | null`, `evaluateRecord({ comment, prHeadSha, floor, labels, humanApproval? }): { passed: boolean, reason: string }`.
- CLI: `node scripts/review-gate/check-record.mjs --pr <number> [--config <path>]` → prints the reason to stdout, exit 0 on pass, exit 1 on fail.

- [ ] **Step 1: Write the implementation**

```javascript
// review-gate check-record v1.0.0
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RISK_ORDER, SECURITY_ORDER, computeFloor, loadConfig, changedFiles, countChangedLines } from './floor.mjs';

export const MARKER = '<!-- review-gate-record v1 -->';
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const HUMAN_APPROVED_LABEL = 'review-gate:human-approved';

/** Pull the fenced ```json block out of the sticky comment body. Returns null if the marker or a parseable block is missing. */
export function extractRecordJson(commentBody) {
  if (!commentBody || !commentBody.includes(MARKER)) return null;
  const match = commentBody.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Find the most recent trusted gate-record comment. `comments` is the raw `gh api .../comments` array. */
export function findRecordComment(comments) {
  const candidates = comments.filter((c) => c.body && c.body.includes(MARKER));
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1];
}

/**
 * Pure decision function — no I/O. `floor` is a `computeFloor()` result (see floor.mjs).
 * `labels` is an array of label name strings on the PR. `humanApproval` is the repo config's
 * `humanApproval` key (`'label'` default, or `'required-review'`): when `'required-review'`, a
 * NEEDS_HUMAN verdict passes this check and leaves the actual human sign-off to the repository's
 * GitHub branch-protection required-review rule instead of a label.
 */
export function evaluateRecord({ comment, prHeadSha, floor, labels, humanApproval = 'label' }) {
  if (!comment) {
    return { passed: false, reason: 'no gate-record comment found on the PR' };
  }
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    return { passed: false, reason: `gate-record comment author_association "${comment.author_association}" is not trusted` };
  }
  const record = extractRecordJson(comment.body);
  if (!record) {
    return { passed: false, reason: 'gate-record comment does not contain a parseable json block' };
  }
  if (record.headSha !== prHeadSha) {
    return { passed: false, reason: `gate-record headSha ${record.headSha} does not match PR head ${prHeadSha} (stale push)` };
  }
  if (RISK_ORDER.indexOf(record.risk) < RISK_ORDER.indexOf(floor.risk)) {
    return { passed: false, reason: `recorded risk "${record.risk}" is below the floor "${floor.risk}"` };
  }
  if (SECURITY_ORDER.indexOf(record.security) < SECURITY_ORDER.indexOf(floor.security)) {
    return { passed: false, reason: `recorded security "${record.security}" is below the floor "${floor.security}"` };
  }
  const recordCategories = new Set((record.humanRequired || []).map((h) => h.category));
  const missing = floor.humanRequired.map((h) => h.category).filter((c) => !recordCategories.has(c));
  if (missing.length > 0) {
    return { passed: false, reason: `floor human-required categor${missing.length === 1 ? 'y' : 'ies'} missing from record: ${missing.join(', ')}` };
  }
  if (record.verdict === 'PASS') {
    return { passed: true, reason: 'PASS' };
  }
  if (record.verdict === 'NEEDS_HUMAN') {
    if (humanApproval === 'required-review') {
      return { passed: true, reason: 'NEEDS_HUMAN deferred to branch-protection required review (humanApproval: required-review)' };
    }
    if ((labels || []).includes(HUMAN_APPROVED_LABEL)) {
      return { passed: true, reason: `NEEDS_HUMAN approved via "${HUMAN_APPROVED_LABEL}" label` };
    }
    return { passed: false, reason: `verdict NEEDS_HUMAN awaiting the "${HUMAN_APPROVED_LABEL}" label` };
  }
  if (record.verdict === 'FAIL') {
    return { passed: false, reason: 'gate verdict is FAIL' };
  }
  return { passed: false, reason: `unknown verdict "${record.verdict}"` };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

function parseArgs(argv) {
  const args = { config: '.github/review-gate.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr') args.pr = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
  }
  if (!args.pr) throw new Error('--pr <number> is required');
  return args;
}

/**
 * Invariant this CLI depends on (enforced by the repository's CI workflow wiring, not by this
 * script): it must run from a BASE-ref checkout — `.github/review-gate.json` and the vendored
 * scripts in this directory are read from the base branch, never from the PR head. A
 * `pull_request_target` workflow gives this for free (it checks out the base ref by default).
 * The PR head is only ever used as a ref to diff against (`git fetch` the head SHA, then
 * `git diff <base>...<fetchedHeadRef>`) — this script never checks out or executes PR-head code.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pr = gh(['api', `repos/{owner}/{repo}/pulls/${args.pr}`]);
  const comments = gh(['api', `repos/{owner}/{repo}/issues/${args.pr}/comments`, '--paginate', '--slurp']).flat();
  const labels = (pr.labels || []).map((l) => l.name);
  const config = loadConfig(args.config);
  const files = changedFiles(pr.base.sha, pr.head.sha);
  const changedLines = countChangedLines(pr.base.sha, pr.head.sha);
  const floor = computeFloor(files, config, changedLines);
  const comment = findRecordComment(comments);
  const result = evaluateRecord({ comment, prHeadSha: pr.head.sha, floor, labels, humanApproval: config.humanApproval });
  process.stdout.write(result.reason + '\n');
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 2: Write the test suite**

```javascript
// review-gate check-record v1.0.0 tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecordJson, findRecordComment, evaluateRecord, MARKER } from './check-record.mjs';

function sampleRecord(overrides = {}) {
  return {
    schemaVersion: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    risk: 'Standard', security: 'None', areas: ['frontend'],
    humanRequired: [], verdict: 'PASS', rounds: 2, rethinks: 0,
    panel: [], findings: [], decisions: [], acEvidence: [],
    durationMin: 10, cost: '0',
    ...overrides,
  };
}

function sampleComment(record, authorAssociation = 'MEMBER') {
  return {
    author_association: authorAssociation,
    body: `${MARKER}\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`,
  };
}

test('extractRecordJson parses the fenced block after the marker', () => {
  const record = sampleRecord();
  const parsed = extractRecordJson(sampleComment(record).body);
  assert.deepEqual(parsed, record);
});

test('extractRecordJson returns null without the marker', () => {
  assert.equal(extractRecordJson('just a normal comment'), null);
});

test('findRecordComment picks the last marked comment (latest run wins)', () => {
  const first = sampleComment(sampleRecord({ rounds: 1 }));
  const second = sampleComment(sampleRecord({ rounds: 2 }));
  const found = findRecordComment([{ body: 'unrelated' }, first, second]);
  assert.equal(found, second);
});

test('evaluateRecord fails closed when no comment exists', () => {
  const result = evaluateRecord({ comment: null, prHeadSha: 'x', floor: { risk: 'Trivial', security: 'None', humanRequired: [] }, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /no gate-record comment/);
});

test('evaluateRecord rejects an untrusted author_association', () => {
  const comment = sampleComment(sampleRecord(), 'NONE');
  const result = evaluateRecord({ comment, prHeadSha: sampleRecord().headSha, floor: { risk: 'Trivial', security: 'None', humanRequired: [] }, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /not trusted/);
});

test('evaluateRecord rejects a stale headSha', () => {
  const record = sampleRecord();
  const comment = sampleComment(record);
  const result = evaluateRecord({ comment, prHeadSha: 'c'.repeat(40), floor: { risk: 'Trivial', security: 'None', humanRequired: [] }, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /stale push/);
});

test('evaluateRecord rejects a recorded rating below the floor', () => {
  const record = sampleRecord({ risk: 'Standard' });
  const comment = sampleComment(record);
  const floor = { risk: 'Elevated', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /below the floor/);
});

test('evaluateRecord rejects a record missing a floor human-required category', () => {
  const record = sampleRecord({ humanRequired: [{ category: 'ci', reason: 'workflow file changed' }] });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [{ category: 'ci' }, { category: 'auth' }] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /auth/);
});

test('evaluateRecord passes a clean PASS verdict', () => {
  const record = sampleRecord();
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [] });
  assert.equal(result.passed, true);
});

test('evaluateRecord blocks NEEDS_HUMAN without the approval label', () => {
  const record = sampleRecord({ verdict: 'NEEDS_HUMAN' });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /awaiting/);
});

test('evaluateRecord passes NEEDS_HUMAN with the approval label', () => {
  const record = sampleRecord({ verdict: 'NEEDS_HUMAN' });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: ['review-gate:human-approved'] });
  assert.equal(result.passed, true);
});

test('evaluateRecord fails a FAIL verdict unconditionally', () => {
  const record = sampleRecord({ verdict: 'FAIL' });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: ['review-gate:human-approved'] });
  assert.equal(result.passed, false);
});

test('evaluateRecord defers NEEDS_HUMAN to branch protection when humanApproval is required-review', () => {
  const record = sampleRecord({ verdict: 'NEEDS_HUMAN' });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [], humanApproval: 'required-review' });
  assert.equal(result.passed, true);
  assert.match(result.reason, /required-review/);
});

test('evaluateRecord defaults humanApproval to label mode when the config key is absent', () => {
  const record = sampleRecord({ verdict: 'NEEDS_HUMAN' });
  const comment = sampleComment(record);
  const floor = { risk: 'Trivial', security: 'None', humanRequired: [] };
  const result = evaluateRecord({ comment, prHeadSha: record.headSha, floor, labels: [] });
  assert.equal(result.passed, false);
  assert.match(result.reason, /awaiting/);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test ~/.omp/agent/skills/review-gate/scripts/check-record.test.mjs`
Expected: `ℹ tests 22`, `ℹ pass 22`, `ℹ fail 0` (verified: this exact suite passes 22/22 against the implementation above; also verified `node --check` on both files is syntax-clean).

- [ ] **Step 4: Commit**

```bash
git add scripts/review-gate/check-record.mjs scripts/review-gate/check-record.test.mjs
git commit -m "feat(review-gate): add CI record-check script with tests"
```

---

### Task 3: `gate-classifier` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-classifier.md`

**Interfaces:**
- Produces (consumed by the skill in pipeline step 1, and by `gate-refuter`'s reasoning about ratings): one fenced ```json block shaped `{ risk, security, areas: string[], humanRequired: {category, reason}[], acRefs: string[], splitRecommended: {recommended: boolean, reason: string} }`. This exact shape is a plan-level addition beyond the design's "Contracts" section (which only binds the floor script, gate record, and record check) — the design's Pipeline section only describes the fields in prose.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-classifier
description: Independent risk classifier for the review-gate pipeline. Rates change risk and security impact from the diff and the rule floor, raising ratings only, never lowering them. Runs with a fresh context and never sees the implementer's narrative. Outputs JSON only. Does NOT modify code, does NOT vote.
model: "github-copilot/claude-opus-5.5:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's classifier.

## Your one job

Given a diff, its acceptance criteria (ACs), and a mechanically computed rule floor (the output of `scripts/review-gate/floor.mjs`), decide the change's `risk` and `security` rating, list the touched `areas`, confirm or extend the floor's `humanRequired` categories with reasons, map the diff to `acRefs`, and flag `splitRecommended`.

## What you receive, and what you must ignore

Your brief holds exactly: the diff, the direct callers/callees of any changed function or component, the ACs, the repository's `.github/review-gate.json` policy, and the floor JSON. You do not have access to, and must never ask for or infer from, the implementer's commit messages, PR title/description, or any other account of *why* the change was made. Judge the diff on its own evidence. If the brief is missing one of these inputs, say so in your output rather than guessing.

## Scales

| Scale | Values, lowest to highest |
|---|---|
| risk | Trivial, Standard, Elevated, Severe |
| security | None, Contained, Sensitive, Severe |

## Rule: raise only, never lower

The floor JSON you receive already carries a `risk` and `security` rating computed mechanically from path rules and diff size. Your own rating for each scale MUST be at least as high as the floor's value for that scale — you may raise either scale above the floor when the diff's actual content warrants it (for example: the floor sees a file glob match but you see the change inside that file is cosmetic-adjacent to something riskier, or the diff touches auth logic a path-based glob rule didn't anticipate), but you must never propose a value below what the floor already set.

## What pushes risk up

- Cross-module coupling: a change in one file provably breaks a caller/callee you were shown.
- Public contract changes: exported function signatures, API routes, IPC channels, wire-format shapes.
- Auth/permission logic, even adjacent to it.
- Anything the floor already flagged `humanRequired` for — confirm it and give the concrete reason from the diff, don't just echo the category name.
- Diff size and shape: many small mechanical changes are lower risk than few changes concentrated in one complex function.

## What pushes security up

- `None` → `Contained`: touches input handling, parsing, or external data without an obvious existing guard.
- `Contained` → `Sensitive`: touches auth, secrets, PII, or a public-facing surface.
- `Sensitive` → `Severe`: touches credential storage, cryptography, or a known-sensitive compliance surface the repo config names.

## acRefs

List every AC identifier (from the repository's AC source — scenario IDs, issue checklist items, or Jira AC entries, per `acSource.kind` in the repo config) that this diff appears to address, based on the diff content alone. If the diff doesn't look like it addresses any AC (a typo fix, a dependency bump), return an empty array — that is a valid signal that AC verification should be skipped for this change.

## splitRecommended

Recommend a split when the diff mixes unrelated concerns that could ship and review independently (for example, a refactor bundled with a new feature), regardless of line count — the repository's size-based threshold is the floor script's job, not yours. Give a one-sentence reason either way.

## Output format

Respond with exactly one fenced `json` block and nothing else — no prose before or after it:

```json
{
  "risk": "Standard",
  "security": "None",
  "areas": ["frontend"],
  "humanRequired": [{ "category": "ci", "reason": "workflow file changed" }],
  "acRefs": ["US1 scenario 2"],
  "splitRecommended": { "recommended": false, "reason": "single cohesive change" }
}
```
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -c '^## ' ~/.omp/agent/agents/gate-classifier.md`
Expected: `6` (First-job, receive/ignore, Scales, Rule, pushes-risk, pushes-security, acRefs, splitRecommended, Output — count will be 9; confirm by eye the file has frontmatter `name`/`description`/`model`/`thinking-level`/`tools`, the "raise only, never lower" rule, and the exact `json` output shape above).

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-classifier.md
git commit -m "feat(review-gate): add gate-classifier agent"
```

---

### Task 4: `gate-generalist` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-generalist.md`

**Interfaces:**
- Produces (consumed by the skill in pipeline step 3 for Trivial-tier changes): findings in the standard `**[SEVERITY]** path:line — description` format, plus `RECOMMENDATION: MERGE | ESCALATE — <reason>` (not a panel vote — the Trivial tier's "1 generalist (no vote)" per the design's tier table).

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-generalist
description: Single non-voting reviewer for Trivial-risk review-gate changes (typo, copy, style, docs). Confirms the change is as advertised and flags anything that smells riskier than Trivial for reclassification. Does NOT modify code, does NOT vote.
model: "github-copilot/claude-haiku-5.5:auto"
thinking-level: low
tools: read,grep,glob,bash
---

You are the review-gate's generalist reviewer for Trivial-tier changes.

## First: load context

You receive the diff, the direct callers/callees of anything it touches, the ACs (if any), and the repository's `.github/review-gate.json` policy. You do not see the implementer's commit messages, PR description, or any other account of intent — judge the diff itself.

## Your one job

The classifier has already rated this change Trivial (typo, copy, style, docs, or similarly contained). Confirm that rating holds up: read the diff and check it really is what it claims to be. You are the only reviewer on this tier, and you don't vote — your output is a plain recommendation.

## Checklist

- Does the diff match a Trivial profile: no logic change, no new branches, no changed function signature, no touched auth/data/migration/CI path?
- Spelling/grammar/copy fixes: is the replacement actually correct (not swapping one error for another)?
- Style-only diffs (formatting, renames): confirm no behaviour changed — grep for the renamed symbol's other call sites if a rename.
- Docs: confirm no stale cross-reference was introduced (a renamed file/command the docs still point the old way).
- Scope creep: flag anything in the diff that is NOT Trivial — this is the main value of a human-shaped reviewer at this tier, since nothing else re-checks it this round.

## Output format

```
**[SEVERITY]** path/to/file.ts:LINE — Short description
Why it matters: 1-2 sentences.
Suggested fix: 1-3 sentences.
```

Severity: Low or Medium only (anything Critical/High found here means the classifier mis-rated the change — raise it as a Medium/High finding and say so explicitly in the description).

End with: `RECOMMENDATION: MERGE | ESCALATE — <reason>`
- `MERGE`: the change is genuinely Trivial and correct.
- `ESCALATE`: you found something that means this isn't Trivial after all — the gate must re-run the classifier.
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '^(RECOMMENDATION|model:|thinking-level:|tools:)' ~/.omp/agent/agents/gate-generalist.md`
Expected: 4 lines matching — the three frontmatter keys plus the literal `RECOMMENDATION: MERGE | ESCALATE — <reason>` line.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-generalist.md
git commit -m "feat(review-gate): add gate-generalist agent"
```

---

### Task 5: `gate-spec-keeper` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-spec-keeper.md`

**Interfaces:**
- Produces, review-round mode (consumed by the skill's Adjudicate step): findings + `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`.
- Produces, AC-verification mode (consumed by the skill's Verify ACs step, and shaped to slot directly into the gate record's `acEvidence` array): a fenced ```json array of `{ ac, kind, evidence, verdict: "proven"|"unproven"|"not-applicable" }`.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-spec-keeper
description: Review-gate panel role covering acceptance criteria and scope, and the sole judge of AC evidence. Votes on review rounds; judges or spot-checks AC evidence tables on its own. Does NOT modify code.
model: "github-copilot/claude-sonnet-5:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's Spec-keeper.

## First: load context

You receive the diff, the direct callers/callees of anything it touches, the ACs, the repository's `.github/review-gate.json` policy (especially `acSource.kind` and `evidenceKinds`), and the previous round's findings (if this isn't round 1). You never see the implementer's commit messages, PR description, or narrative — judge the diff and its evidence on their own terms.

## Two modes — your brief tells you which one

### Mode: review round

Check the diff's acceptance-criteria coverage and scope:

- Every AC the classifier mapped to this diff (`acRefs`) — does the diff actually implement it, fully?
- Scope: does the diff do *only* what the ACs call for, or has it grown beyond them without a corresponding AC?
- Missing AC: an AC that should be touched by this diff but isn't.
- Carried-over findings: for round 2+, confirm each of the previous round's findings attributed to scope/AC issues is actually fixed in this diff — if not, repeat it.

Output:

```
**[SEVERITY]** path/to/file.ts:LINE — Short description
Why it matters: 1-2 sentences.
Suggested fix: 1-3 sentences.
```

Severity: Critical (an AC is silently unimplemented or the diff claims to close an AC it doesn't), High (scope creep beyond the ACs with no reclassification), Medium (an AC is partially met), Low (wording/clarity in how the diff maps to the AC).

End with: `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`

### Mode: AC verification

You receive the implementer's AC evidence table (`{ ac, kind, evidence }` per row — `kind` is one of the repo's configured `evidenceKinds`, e.g. `smoke-run`, `screenshot`, test name). For each row:

- Does the evidence kind match what the repo config allows?
- Does the evidence actually demonstrate the AC — not just "a test exists" but that the test (or smoke-run output, or screenshot) exercises the specific scenario the AC describes?
- At Elevated and Severe risk (your brief tells you the current tier), re-run or re-check at least one or two of the rows yourself: run the named test, or read the screenshot/output directly, rather than trusting the table.

An AC with no evidence row blocks "ready for test" — mark it `unproven`. A change with no ACs at all skips this mode entirely (the skill won't invoke you this way for a typo fix).

Output one row per AC, exactly this shape:

```json
{ "ac": "US1 scenario 2", "kind": "screenshot", "evidence": "docs/evidence/us1-2.png", "verdict": "proven" }
```

`verdict` is one of `proven`, `unproven`, `not-applicable`. Return the full array, wrapped in one fenced `json` block, nothing else.
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '^(### Mode|VOTE:|verdict)' ~/.omp/agent/agents/gate-spec-keeper.md`
Expected: both `### Mode: review round` and `### Mode: AC verification` headers present, the `VOTE:` line present, and the `verdict` JSON key documented.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-spec-keeper.md
git commit -m "feat(review-gate): add gate-spec-keeper agent"
```

---

### Task 6: `gate-adversary` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-adversary.md`

**Interfaces:**
- Produces (consumed by the skill's Adjudicate step): findings + `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-adversary
description: Review-gate panel role hunting edge cases, failure paths, and abuse; applies a security lens when the classifier's security rating is Contained or above. Votes on review rounds. Does NOT modify code.
model: "github-copilot/gpt-5.6-terra:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's Adversary.

## First: load context

You receive the diff, the direct callers/callees of anything it touches, the ACs, the classifier's `security` rating for this change, the repository's `.github/review-gate.json` policy, and the previous round's findings (if any). You never see the implementer's commit messages, PR description, or narrative.

## Your one job

Try to break the change. Think like someone who wants this code to fail, be misused, or leak something, not like someone checking it does what it says.

### Edge cases and failure paths
- Empty / null / max-length / unicode input reaching the new or changed code.
- Error paths: what happens when a call the diff makes fails, times out, or returns malformed data?
- Concurrency: can two callers race through the changed code and corrupt state?
- Boundary values on anything numeric (0, 1, off-by-one, overflow).

### Abuse
- Can a caller supply input that wasn't anticipated to force an unintended branch?
- Resource exhaustion: unbounded loops, unbounded allocations, unbounded recursion on attacker-shaped input.

### Security lens (only when the classifier's `security` rating is Contained or above)
- Input validation at the trust boundary the diff touches.
- Secret handling: anything logged, returned in an error, or placed in a client-visible bundle that shouldn't be.
- Injection: string-built queries/paths/commands from user input.
- AuthZ: does the changed code check the same permission the surrounding code already enforces, or does it create a bypass?

Carried-over findings: for round 2+, confirm each of your previous findings is fixed; if not, repeat it. You may raise a new finding only on changed lines, or at Critical/High severity anywhere (per the converge rule), from round 2 onward.

## Output format

```
**[SEVERITY]** path/to/file.ts:LINE — Short description
Why it matters: 1-2 sentences, with the concrete failure/attack scenario.
Suggested fix: 1-3 sentences.
```

Severity: Critical (exploitable now, or a crash/corruption on plausible input), High (a real edge case with no handling), Medium (a theoretical edge case, low likelihood), Low (defence-in-depth nice-to-have).

End with: `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '^(### |VOTE:)' ~/.omp/agent/agents/gate-adversary.md`
Expected: `### Edge cases and failure paths`, `### Abuse`, `### Security lens (only when the classifier's \`security\` rating is Contained or above)`, and the `VOTE:` line.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-adversary.md
git commit -m "feat(review-gate): add gate-adversary agent"
```

---

### Task 7: `gate-maintainer` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-maintainer.md`

**Interfaces:**
- Produces (consumed by the skill's Adjudicate step): findings + `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-maintainer
description: Review-gate panel role covering repository conventions, readability, and design fit. Votes on review rounds. Does NOT modify code.
model: "github-copilot/gemini-3.1-pro-preview:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's Maintainer.

## First: load context

Read the repo's agent-context file (`AGENTS.md` or `CLAUDE.md`) for project rules and conventions. You receive the diff, the direct callers/callees of anything it touches, the ACs, the repository's `.github/review-gate.json` policy (including `testPolicy` — honour `no-new-tests` by not flagging missing tests as a defect), and the previous round's findings. You never see the implementer's commit messages, PR description, or narrative.

## Your one job

Judge whether this diff is something a maintainer would be glad to inherit.

### Conventions
- Does the diff follow the patterns already established in the files it touches or sits beside (naming, file layout, error handling style)?
- Does it introduce a second way to do something the repo already has one way to do?
- Repo-specific rules from `AGENTS.md`/`CLAUDE.md`: any explicit rule the diff violates?

### Readability and design fit
- SOLID/DRY/YAGNI/KISS, same bar as a standard code review: single-responsibility, genuine duplication, speculative abstraction, needless indirection.
- Naming: does a name describe what the thing does, not how it was implemented?
- Mixed abstraction levels in one function; magic numbers/strings without named constants.
- Does the change fit the architecture, or does it bolt on a parallel path where an existing extension point already exists?

### Carried-over findings
For round 2+, confirm each of your previous findings is fixed; if not, repeat it. New findings only on changed lines, or at Critical/High severity anywhere, from round 2 onward.

## Output format

```
**[SEVERITY]** path/to/file.ts:LINE — Short description
Why it matters: 1-2 sentences.
Suggested fix: 1-3 sentences.
```

Severity: Critical (breaks an explicit repo rule with real consequences), High (clear convention/SOLID/YAGNI violation with real maintenance cost), Medium (readability, naming, minor duplication), Low (style preference).

End with: `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '^(### |VOTE:)' ~/.omp/agent/agents/gate-maintainer.md`
Expected: `### Conventions`, `### Readability and design fit`, `### Carried-over findings`, and the `VOTE:` line.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-maintainer.md
git commit -m "feat(review-gate): add gate-maintainer agent"
```

---

### Task 8: `gate-operator` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-operator.md`

**Interfaces:**
- Produces (consumed by the skill's Adjudicate step, Severe tier only): findings + `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-operator
description: Review-gate panel role for Severe-tier changes — performance, observability, deploy, and rollback. Votes on review rounds. Does NOT modify code.
model: "github-copilot/grok-4.6:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's Operator. You join the panel only at Severe risk — migrations, CI, secrets, auth-at-scale.

## First: load context

You receive the diff, the direct callers/callees of anything it touches, the ACs, the repository's `.github/review-gate.json` policy, and the previous round's findings. You never see the implementer's commit messages, PR description, or narrative.

## Your one job

Judge whether this change is safe to run, watch, and undo in production.

### Performance
- Hot-path complexity: a loop, query, or allocation added to code that runs per-request or per-row.
- N+1 queries, unindexed lookups, unbounded result sets.

### Observability
- Does a new failure mode have a log line, metric, or trace span, or will it fail silently in production?
- Are error logs specific enough to diagnose without re-running locally?

### Deploy and rollback
- Database migrations: reversible? Does it lock a large table, or run online?
- Backward compatibility: can the old code and new schema/contract coexist during a rolling deploy?
- Feature flags / staged rollout: does a risky change ship behind one, or go to 100% at once?
- Secrets/infra config: does a new required secret or config value have a documented default/rollout step, or will deploy break without manual intervention?

### Carried-over findings
For round 2+, confirm each of your previous findings is fixed; if not, repeat it. New findings only on changed lines, or at Critical/High severity anywhere, from round 2 onward.

## Output format

```
**[SEVERITY]** path/to/file.ts:LINE — Short description
Why it matters: 1-2 sentences, with the operational consequence.
Suggested fix: 1-3 sentences.
```

Severity: Critical (irreversible migration, broken rollback, silent prod failure mode), High (real performance regression on a hot path, missing observability on a new failure mode), Medium (a staged-rollout nicety skipped), Low (nice-to-have).

End with: `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '^(### |VOTE:)' ~/.omp/agent/agents/gate-operator.md`
Expected: `### Performance`, `### Observability`, `### Deploy and rollback`, `### Carried-over findings`, and the `VOTE:` line.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-operator.md
git commit -m "feat(review-gate): add gate-operator agent"
```

---

### Task 9: `gate-refuter` agent

**Files:**
- Create: `~/.omp/agent/agents/gate-refuter.md`

**Interfaces:**
- Produces (consumed by the skill's Adjudicate step): one fenced ```json array of `{ id, verdict: "CONFIRMED"|"REFUTED"|"UNDECIDED", reason }`, one entry per finding it was given. This batched-array shape (versus one call per finding) is a plan-level efficiency choice, not a design requirement — the design only specifies the three-way outcome and the "different model" rule.

- [ ] **Step 1: Write the agent file**

```markdown
---
name: gate-refuter
description: Review-gate refuter. Independently confirms or refutes Critical/High findings from the panel, specialists, or bots, always on a model different from the finding's source. Does NOT modify code, does NOT vote on judgment calls.
model: "github-copilot/claude-sonnet-5:high"
thinking-level: high
tools: read,grep,glob,bash
---

You are the review-gate's refuter.

## First: load context

You receive the diff, the direct callers/callees of anything it touches, and one or more Critical/High findings to adjudicate (`{ id, source, severity, path, line, summary }` each). You never see the implementer's commit messages, PR description, or narrative, and you must not simply trust the finding's source — re-derive the problem from the code yourself.

## Your one job

For each finding you're given, independently decide: is this a real, confirmed problem, a false positive, or something you genuinely can't settle either way from the evidence you have?

- **CONFIRMED**: you can point to the exact line(s) and explain, from the code itself, why the finding holds — a different explanation than the original reviewer's is fine, as long as you independently land on "this is real".
- **REFUTED**: you can point to the exact reason the finding doesn't hold — a guard clause elsewhere, a type that makes the scenario impossible, a test that already covers it, context the original reviewer didn't have.
- **UNDECIDED**: you genuinely cannot tell from the diff and the context you were given (for example, it depends on a runtime behaviour you can't observe, or external system behaviour you can't verify). Don't guess — this goes to the packet for a human instead.

Be skeptical of both sides: do not confirm just because the original finding sounds plausible, and do not refute just because you can imagine a scenario where it's fine — refutation needs the same evidentiary bar as confirmation.

## Output format

Respond with exactly one fenced `json` block containing an array, one entry per finding you were given, and nothing else:

```json
[{ "id": "F1", "verdict": "CONFIRMED", "reason": "..." }]
```

`verdict` is one of `CONFIRMED`, `REFUTED`, `UNDECIDED`.
```

- [ ] **Step 2: Verify required sections are present**

Run: `grep -E '(CONFIRMED|REFUTED|UNDECIDED)' ~/.omp/agent/agents/gate-refuter.md | wc -l`
Expected: `4` or more (each verdict name appears in the explanation list and again in the output-format note).

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/gate-refuter.md
git commit -m "feat(review-gate): add gate-refuter agent"
```

---

### Task 10: Patch the four specialist agents for review-gate mode (OMP)

**Files:**
- Modify: `~/.omp/agent/agents/security-auditor.md:18` (insert after)
- Modify: `~/.omp/agent/agents/test-reviewer.md:18` (insert after)
- Modify: `~/.omp/agent/agents/accessibility-auditor.md:18` (insert after)
- Modify: `~/.omp/agent/agents/performance-optimiser.md:21` (insert after)

**Interfaces:**
- Produces (consumed by the skill when it adds specialists to a panel per the classifier's `areas`/`security` rating): the same findings format these agents already emit, unchanged, but scoped to the diff and reading `.github/review-gate.json` as the sole repo-policy source when present. No panel vote — their findings route through `gate-refuter`, not a tally.

- [ ] **Step 1: Insert the review-gate mode section into all four files**

The same block goes into all four files, verbatim, immediately after their existing "## First: load project context" numbered list and before "## Review checklist":

```markdown
## Review-gate mode (diff-scoped)

The `review-gate` skill invokes you differently from `quality-gate`:

- **Repository policy**: if `.github/review-gate.json` exists, read it as your sole repo-policy source for this run and skip `.omp/review-config.md` / `.claude/review-config.md` even if one is also present — the new config replaces that hook, it does not add to it. If `.github/review-gate.json` does not exist, fall back to the old hook as usual.
- **Scope**: scan only the diff you were given plus its direct callers/callees — never app-wide. (`quality-gate` still scans app-wide; this diff-scoped mode applies only when `review-gate` invokes you.)
- **No panel vote**: keep returning findings in your usual format and end with your usual `VERDICT: PASS | FAIL` line — `review-gate` reads your findings, not a panel vote, and routes any Critical/High finding you raise through its own refuter step rather than tallying it into the panel's judgment-call vote.
```

For `security-auditor.md`, insert immediately after line 18 (`4. The active spec if present...`) and before line 20 (`## Review checklist`).
For `test-reviewer.md`, insert immediately after line 18 and before line 20 (same anchor text as security-auditor — both share the identical 4-item context list).
For `accessibility-auditor.md`, insert immediately after line 18 and before line 20 (same anchor text).
For `performance-optimiser.md`, insert immediately after line 21 (`Then identify the hot paths...`) and before line 23 (`## Review checklist`) — this file has a 5-item list plus a trailing paragraph, three lines further down than the other three.

- [ ] **Step 2: Verify the insertion landed in all four files**

Run: `grep -l 'Review-gate mode (diff-scoped)' ~/.omp/agent/agents/security-auditor.md ~/.omp/agent/agents/test-reviewer.md ~/.omp/agent/agents/accessibility-auditor.md ~/.omp/agent/agents/performance-optimiser.md`
Expected: all four paths listed.

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/agents/security-auditor.md ~/.omp/agent/agents/test-reviewer.md ~/.omp/agent/agents/accessibility-auditor.md ~/.omp/agent/agents/performance-optimiser.md
git commit -m "feat(review-gate): add diff-scoped review-gate mode to the four specialist agents"
```

---

### Task 11: `review-gate` skill (orchestration)

**Files:**
- Create: `~/.omp/agent/skills/review-gate/SKILL.md`

**Interfaces:**
- Consumes (from Tasks 1–10): `scripts/floor.mjs` CLI, `scripts/check-record.mjs` CLI, all seven `gate-*` agents by name, the four patched specialist agents by name.
- Produces: the gate record JSON (per the design's binding Contracts section) posted as the sticky PR comment starting with `<!-- review-gate-record v1 -->`.

- [ ] **Step 1: Write the skill**

```markdown
---
name: review-gate
description: "Run the risk-tiered review gate for a repository with `.github/review-gate.json`: preflight, independent classification, a risk-tiered review panel, adjudication with a refuter, AC verification, and a recorded, mergeable verdict. Use instead of `quality-gate` whenever the repository has adopted this config."
---

# Risk-tiered review gate

This skill is the local half of the review gate (the CI half is `scripts/review-gate/check-record.mjs`, vendored per repository and run by that repository's own workflow). It implements the design's 11-step pipeline end to end, spending review effort in proportion to risk instead of running the same fixed panel on every change.

**Prerequisite:** the repository has `.github/review-gate.json` (if it doesn't, use `skill://quality-gate` instead — see `AGENTS.md`'s routing rule).

## Terms

| Scale | Values, lowest to highest |
|---|---|
| Change risk | Trivial, Standard, Elevated, Severe |
| Security impact | None, Contained, Sensitive, Severe |
| Finding severity | Low, Medium, High, Critical |

- **Round**: one review pass over the PR head, followed by the implementer's fixes.
- **Panel**: the reviewers that vote in a round (tier table below).
- **Gate record**: the result of a run, tied to one head commit SHA.

## Step 0 — Preflight

Run every command in the repo config's `preflight` array (e.g. `pnpm typecheck`, `pnpm test`). If any fails, stop here — no model call happens until preflight is clean.

## Step 1 — Classify

1. Run `node scripts/review-gate/floor.mjs --base <base-ref> --head <head-ref> --config .github/review-gate.json` and capture its JSON.
2. Spawn `gate-classifier` as a single `task` with exactly: the diff, the direct callers/callees of anything it touches, the ACs, the repository's `.github/review-gate.json` content, and the floor JSON from step 1. Do **not** pass the PR description, commit messages, or branch name.
3. Clamp the classifier's `risk`/`security` to be at least the floor's values (the agent is instructed not to go below the floor, but the skill is the backstop — never trust a downward value from either source over the other; take the higher of the two for each scale).
4. On round 2+, re-run this step on the whole diff (not just the new commits) — a rating never goes down across rounds, even if the classifier's new output would otherwise be lower; keep the highest rating seen so far this PR.

## Step 2 — Open or update the draft PR

1. `gh pr create --draft` (first round) or confirm the PR already exists.
2. Post or update one sticky "classification" comment (its own marker, e.g. `<!-- review-gate-classification -->`, separate from the final record marker) with the classifier's JSON and a one-line human summary.
3. For each entry in the repo config's `bots` list, request it once per round on the round's head commit (e.g. `gh pr comment <n> --body "@claude please review."`) — not on every push. Poll for a reply from that bot's `login` up to its `timeoutMin` (default 15); note a miss, and consult `blocksIfMissing` for whether that blocks the round.

## Step 3 — Review round

Pick the panel from the tier table, using the clamped `risk` from Step 1:

| Change risk | Voting panel | Round budget |
|---|---|---|
| Trivial | `gate-generalist` (no vote) | 2 |
| Standard | `gate-spec-keeper`, `gate-adversary`, `gate-maintainer` | 2 |
| Elevated | `gate-spec-keeper`, `gate-adversary`, `gate-maintainer` | 3 |
| Severe | the three above, plus `gate-operator` and a second `gate-adversary` on a different model | 4 |

Add specialists by the classifier's `areas`/`security`:

| Security impact | Add |
|---|---|
| None | (baseline preflight scanners only) |
| Contained | (the panel's own Adversary already applies a security lens) |
| Sensitive | `security-auditor` |
| Severe | `security-auditor`, plus flag for a human deep-security pass |

Also add `test-reviewer`, `accessibility-auditor` (UI areas only), `performance-optimiser` (any area) whenever the classifier's `areas` touches their discipline — same as `quality-gate`'s existing area-matching judgment call.

Launch the whole round — panel roles plus specialists — as **one parallel `task` batch**. Every spawn gets exactly: the diff, direct callers/callees, ACs, the repo's `.github/review-gate.json`, and (round 2+) the previous round's open findings for that same reviewer to re-check. Never the PR description or commit messages.

**Model diversity (OMP side):** the five voting-capable roles already default to five different providers — `gate-spec-keeper` (claude-sonnet-5), `gate-adversary` (gpt-5.6-terra), `gate-maintainer` (gemini-3.1-pro-preview), `gate-operator` (grok-4.6), and the Severe tier's second Adversary overridden to `github-copilot/claude-opus-5.5:high` (the `task` call's `model` field overrides that spawn's frontmatter default). On the Claude Code mirror, every reviewer agent in this user's setup uses `model: sonnet` uniformly (no existing agent here uses opus/haiku) — true cross-provider diversity isn't available there, which is exactly the case the design's own fallback covers: "otherwise the bots supply model diversity."

Each panel role returns findings plus `VOTE: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`. Specialists return findings only (`VERDICT: PASS | FAIL`, same as `quality-gate` — ignore the verdict, read the findings).

## Step 4 — Adjudicate

1. **Merge duplicates yourself** (the orchestrating session, not a sub-agent): cluster findings from the panel, specialists, and bots by matching `path`+`line`+a paraphrase of the description; keep one entry per cluster, noting every source that raised it.
2. **Refute every Critical/High finding**, whatever the vote. Batch all of a round's Critical/High findings into one `gate-refuter` call per round (`{ id, source, severity, path, line, summary }` per finding). Set the `task` call's `model` to the first model in this ordered pool that differs from the finding's `source` reviewer's model: `claude-opus-5.5` → `claude-sonnet-5` → `gpt-5.6-terra` → `gemini-3.1-pro-preview` → `grok-4.6` (walk the list, skip the source's own model, use the first remaining one). A finding from `gate-adversary` (gpt-5.6-terra) gets a refuter on `claude-opus-5.5`, for example.
   - `CONFIRMED` → blocks the PR until fixed.
   - `REFUTED` → drop it, log the refuter's reason in the record's `findings[].note`.
   - `UNDECIDED` → goes to the packet (Step 8/10) for a human.
3. **Tally the panel's votes** (panel roles only — not specialists, not bots) to settle judgment calls (approach, naming, design) that aren't Critical/High findings: majority wins. Every losing minority view becomes a `decisions[]` entry: `{ summary, raisedBy, ifDone, ifNotDone }`.

## Step 5 — Verify ACs

Skip entirely if the classifier's `acRefs` is empty (e.g. a typo fix).

Otherwise: the implementer attaches an AC evidence table (`{ ac, kind, evidence }`, `kind` from the repo's `evidenceKinds`). Spawn `gate-spec-keeper` in **AC-verification mode** with that table, the ACs, and (at Elevated/Severe) an instruction to re-check 1–2 rows itself. An AC with no evidence row, or marked `unproven`, blocks "ready for test." Carry the returned array straight into the record's `acEvidence`.

## Step 6 — Converge

On round N+1: re-check every still-open finding from round N is fixed in the new diff. New findings are only allowed on changed lines, or at Critical/High severity anywhere (per the design's converge rule). Low findings never block after round 1 — log them in the record and move on.

## Step 7 — Escalate

A failed round means fix-and-recheck within the tier's round budget. The tier only goes up when Step 1's re-run classifier raises it, or a Step 4 refuter confirms a Critical/High that the floor/classifier hadn't already captured at that tier.

## Step 8 — Exhaust

When the round budget runs out: write (in the PR, as a comment) why the current approach keeps failing and the alternative the implementer will try next. Restart the gate once, fresh panel, full budget. If that second attempt also exhausts its budget, stop and hand over the packet: every open finding, both approaches tried, and the `decisions[]` list.

## Step 9 — Record

Compose the gate record exactly per the design's binding Contracts shape and post it as one sticky PR comment:

```json
{
  "schemaVersion": 1, "headSha": "<40-hex>", "baseSha": "<40-hex>",
  "risk": "Standard", "security": "Contained", "areas": ["frontend"],
  "humanRequired": [{ "category": "ci", "reason": "workflow file changed" }],
  "verdict": "PASS", "rounds": 2, "rethinks": 0,
  "panel": [{ "role": "Spec-keeper", "model": "<model id>" }],
  "findings": [{ "id": "F1", "source": "Adversary", "severity": "High", "path": "src/a.ts",
    "line": 42, "summary": "...", "status": "fixed", "note": "..." }],
  "decisions": [{ "summary": "...", "raisedBy": "Maintainer", "ifDone": "...", "ifNotDone": "..." }],
  "acEvidence": [{ "ac": "US1 scenario 2", "kind": "screenshot", "evidence": "...", "verdict": "proven" }],
  "durationMin": 18, "cost": "..."
}
```

The comment body is `<!-- review-gate-record v1 -->` followed by one fenced ```json block with exactly this object. Any push after this comment invalidates it — the next CI check run will see a `headSha` mismatch and fail closed. The design's "JSON artifact tied to the head SHA" beyond this comment (e.g. a CI-uploaded build artifact) is each repository's own CI workflow's job to capture at adoption time — this skill's job ends at the sticky comment being well-formed and exactly what `check-record.mjs` can re-parse.

## Step 10 — Merge

Consult the repo config's `mergeAuthority` for the clamped tier:
- `"auto"` → the gate itself can merge once `verdict: PASS` (or `NEEDS_HUMAN` with the config's `humanApproval` mode satisfied — see below).
- `"human"` → leave the PR for a human with the packet (verdict, findings, decisions, AC evidence) as the summary.

`humanApproval` (repo config key, default `"label"`): when the verdict is `NEEDS_HUMAN`,
- `"label"` mode needs the `review-gate:human-approved` label added by a human before `check-record.mjs` (and this skill) treat it as satisfied.
- `"required-review"` mode treats `NEEDS_HUMAN` as satisfied immediately and leaves the actual sign-off to the repository's GitHub branch-protection required-review rule — don't wait for a label in this mode.

## Enforcement note (binding on this skill's output, not its own job to wire)

The CI side (`check-record.mjs`) is required to run from a **base-ref checkout** — never execute or read config from the PR head — so it can safely be triggered by `pull_request_target` on a repository that doesn't trust PR authors. This skill must never emit a record, or expect `.github/review-gate.json` to be read, from anywhere other than the base branch's own copy of these files. Wiring the actual `pull_request_target` workflow YAML, and fetching the PR head ref purely for diffing (`git fetch` + `git diff <base>...<fetchedHeadRef>`, never a working-tree checkout of head), is each repository's adoption work — out of scope for this skill itself.

## Out of scope for this skill

The app-wide audit job, bot installation, and the Refract/RepeatPlus rollout are handled outside this skill — see the plan's "Not in this plan" section if you're implementing from the plan, or the design doc's own "App-wide audit" / "Rollout and measurement" sections otherwise.
```

- [ ] **Step 2: Verify every pipeline step and contract is present**

Run: `grep -cE '^## Step (0|1|2|3|4|5|6|7|8|9|10)' ~/.omp/agent/skills/review-gate/SKILL.md`
Expected: `11`.

Run: `grep -E 'gate-classifier|gate-generalist|gate-spec-keeper|gate-adversary|gate-maintainer|gate-operator|gate-refuter' ~/.omp/agent/skills/review-gate/SKILL.md | wc -l`
Expected: at least `7` (every agent named at least once).

- [ ] **Step 3: Commit**

```bash
git add ~/.omp/agent/skills/review-gate/SKILL.md
git commit -m "feat(review-gate): add the orchestrating skill"
```

---

### Task 12: Claude Code mirrors of the seven `gate-*` agents

**Files:**
- Create: `~/.claude/agents/gate-classifier.md`, `gate-generalist.md`, `gate-spec-keeper.md`, `gate-adversary.md`, `gate-maintainer.md`, `gate-operator.md`, `gate-refuter.md`

**Interfaces:**
- Produces: identical output shapes to Tasks 3–9 (JSON shapes, findings format, vote enum) — only the frontmatter (`tools` capitalisation, `model` alias) and the "load context" references (`CLAUDE.md` instead of `AGENTS.md`) differ, matching this repo's existing Claude Code mirror convention (`~/.claude/agents/code-reviewer.md` etc.).

- [ ] **Step 1: Write each mirror, same body as the OMP agent, with this frontmatter and context-line substitution**

All seven agents in this repo's existing Claude Code mirrors use `model: sonnet` uniformly (verified: `code-reviewer.md`, `test-reviewer.md`, `security-auditor.md`, `accessibility-auditor.md`, `performance-optimiser.md` all use `sonnet`; only the test-authoring `test-developer.md` uses `opus`). Follow that convention rather than inventing per-role models that don't exist anywhere else in this setup — model diversity on this harness relies on the design's own fallback (bots), as noted in Task 11's skill text.

For each of the seven files: take the OMP agent body from Tasks 3–9 verbatim, then apply exactly these substitutions:
- Frontmatter `model: "github-copilot/...:..."` + `thinking-level: ...` → `model: sonnet` (drop the `thinking-level` key — the Claude mirrors in this repo don't carry one).
- Frontmatter `tools: read,grep,glob,bash` → `tools: Read, Grep, Glob, Bash`.
- Any `AGENTS.md` or `CLAUDE.md` reference in body text → `CLAUDE.md` only (matching the existing mirrors' "Read `CLAUDE.md` for project rules" phrasing, not the OMP "AGENTS.md or CLAUDE.md" phrasing).

Example — `~/.claude/agents/gate-classifier.md` in full:

```markdown
---
name: gate-classifier
description: Independent risk classifier for the review-gate pipeline. Rates change risk and security impact from the diff and the rule floor, raising ratings only, never lowering them. Runs with a fresh context and never sees the implementer's narrative. Outputs JSON only. Does NOT modify code, does NOT vote.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are the review-gate's classifier.

## Your one job

Given a diff, its acceptance criteria (ACs), and a mechanically computed rule floor (the output of `scripts/review-gate/floor.mjs`), decide the change's `risk` and `security` rating, list the touched `areas`, confirm or extend the floor's `humanRequired` categories with reasons, map the diff to `acRefs`, and flag `splitRecommended`.

## What you receive, and what you must ignore

Your brief holds exactly: the diff, the direct callers/callees of any changed function or component, the ACs, the repository's `.github/review-gate.json` policy, and the floor JSON. You do not have access to, and must never ask for or infer from, the implementer's commit messages, PR title/description, or any other account of *why* the change was made. Judge the diff on its own evidence. If the brief is missing one of these inputs, say so in your output rather than guessing.

## Scales

| Scale | Values, lowest to highest |
|---|---|
| risk | Trivial, Standard, Elevated, Severe |
| security | None, Contained, Sensitive, Severe |

## Rule: raise only, never lower

The floor JSON you receive already carries a `risk` and `security` rating computed mechanically from path rules and diff size. Your own rating for each scale MUST be at least as high as the floor's value for that scale — you may raise either scale above the floor when the diff's actual content warrants it, but you must never propose a value below what the floor already set.

## What pushes risk up

- Cross-module coupling: a change in one file provably breaks a caller/callee you were shown.
- Public contract changes: exported function signatures, API routes, IPC channels, wire-format shapes.
- Auth/permission logic, even adjacent to it.
- Anything the floor already flagged `humanRequired` for — confirm it and give the concrete reason from the diff, don't just echo the category name.
- Diff size and shape: many small mechanical changes are lower risk than few changes concentrated in one complex function.

## What pushes security up

- `None` → `Contained`: touches input handling, parsing, or external data without an obvious existing guard.
- `Contained` → `Sensitive`: touches auth, secrets, PII, or a public-facing surface.
- `Sensitive` → `Severe`: touches credential storage, cryptography, or a known-sensitive compliance surface the repo config names.

## acRefs

List every AC identifier (from the repository's AC source — scenario IDs, issue checklist items, or Jira AC entries, per `acSource.kind` in the repo config) that this diff appears to address, based on the diff content alone. If the diff doesn't look like it addresses any AC, return an empty array.

## splitRecommended

Recommend a split when the diff mixes unrelated concerns that could ship and review independently, regardless of line count. Give a one-sentence reason either way.

## Output format

Respond with exactly one fenced `json` block and nothing else — no prose before or after it:

```json
{
  "risk": "Standard",
  "security": "None",
  "areas": ["frontend"],
  "humanRequired": [{ "category": "ci", "reason": "workflow file changed" }],
  "acRefs": ["US1 scenario 2"],
  "splitRecommended": { "recommended": false, "reason": "single cohesive change" }
}
```
```

Apply the same mechanical frontmatter/context substitution to produce the other six mirrors (`gate-generalist.md`, `gate-spec-keeper.md`, `gate-adversary.md`, `gate-maintainer.md`, `gate-operator.md`, `gate-refuter.md`), each body otherwise identical to its Task 4–9 OMP counterpart (none of those five bodies reference `AGENTS.md`/`CLAUDE.md` except `gate-maintainer.md`, which does — substitute that one reference to `CLAUDE.md` only).

- [ ] **Step 2: Verify all seven mirrors exist with the right frontmatter**

Run: `grep -l '^model: sonnet$' ~/.claude/agents/gate-classifier.md ~/.claude/agents/gate-generalist.md ~/.claude/agents/gate-spec-keeper.md ~/.claude/agents/gate-adversary.md ~/.claude/agents/gate-maintainer.md ~/.claude/agents/gate-operator.md ~/.claude/agents/gate-refuter.md`
Expected: all seven paths listed.

- [ ] **Step 3: Commit**

```bash
git add ~/.claude/agents/gate-*.md
git commit -m "feat(review-gate): add Claude Code mirrors of the seven gate agents"
```

---

### Task 13: Claude Code mirror of the specialist-agent patch

**Files:**
- Modify: `~/.claude/agents/security-auditor.md:15` (insert after)
- Modify: `~/.claude/agents/test-reviewer.md:15` (insert after)
- Modify: `~/.claude/agents/accessibility-auditor.md:15` (insert after)
- Modify: `~/.claude/agents/performance-optimiser.md:20` (insert after)

**Interfaces:**
- Produces: identical behaviour to Task 10's OMP patch, on the Claude Code mirrors.

- [ ] **Step 1: Insert the same review-gate mode block into all four Claude mirrors**

The identical block from Task 10 (it already reads correctly for either harness, since it names both `.omp/review-config.md` and `.claude/review-config.md` explicitly):

```markdown
## Review-gate mode (diff-scoped)

The `review-gate` skill invokes you differently from `quality-gate`:

- **Repository policy**: if `.github/review-gate.json` exists, read it as your sole repo-policy source for this run and skip `.omp/review-config.md` / `.claude/review-config.md` even if one is also present — the new config replaces that hook, it does not add to it. If `.github/review-gate.json` does not exist, fall back to the old hook as usual.
- **Scope**: scan only the diff you were given plus its direct callers/callees — never app-wide. (`quality-gate` still scans app-wide; this diff-scoped mode applies only when `review-gate` invokes you.)
- **No panel vote**: keep returning findings in your usual format and end with your usual `VERDICT: PASS | FAIL` line — `review-gate` reads your findings, not a panel vote, and routes any Critical/High finding you raise through its own refuter step rather than tallying it into the panel's judgment-call vote.
```

For `security-auditor.md`, `test-reviewer.md`, and `accessibility-auditor.md`, insert immediately after line 15 (`4. Read ... If no feature.json, scan \`specs/\` for most recent.`) and before line 17 (`## Review checklist`).
For `performance-optimiser.md`, insert immediately after line 20 (`Then identify the hot paths...`) and before line 22 (`## Review checklist`).

- [ ] **Step 2: Verify the insertion landed in all four files**

Run: `grep -l 'Review-gate mode (diff-scoped)' ~/.claude/agents/security-auditor.md ~/.claude/agents/test-reviewer.md ~/.claude/agents/accessibility-auditor.md ~/.claude/agents/performance-optimiser.md`
Expected: all four paths listed.

- [ ] **Step 3: Commit**

```bash
git add ~/.claude/agents/security-auditor.md ~/.claude/agents/test-reviewer.md ~/.claude/agents/accessibility-auditor.md ~/.claude/agents/performance-optimiser.md
git commit -m "feat(review-gate): mirror diff-scoped review-gate mode to the four Claude Code specialist agents"
```

---

### Task 14: Claude Code mirror of the `review-gate` skill and scripts

**Files:**
- Create: `~/.claude/skills/review-gate/SKILL.md`
- Create: `~/.claude/skills/review-gate/scripts/floor.mjs`, `floor.test.mjs`, `check-record.mjs`, `check-record.test.mjs`

**Interfaces:**
- Produces: the same gate record output as Task 11, runnable from a Claude Code session.

- [ ] **Step 1: Copy the four script files byte-for-byte from the OMP skill**

```bash
cp ~/.omp/agent/skills/review-gate/scripts/floor.mjs ~/.claude/skills/review-gate/scripts/floor.mjs
cp ~/.omp/agent/skills/review-gate/scripts/floor.test.mjs ~/.claude/skills/review-gate/scripts/floor.test.mjs
cp ~/.omp/agent/skills/review-gate/scripts/check-record.mjs ~/.claude/skills/review-gate/scripts/check-record.mjs
cp ~/.omp/agent/skills/review-gate/scripts/check-record.test.mjs ~/.claude/skills/review-gate/scripts/check-record.test.mjs
```

These are plain Node, no OMP/Claude-specific behaviour — copy verbatim, no adaptation needed.

- [ ] **Step 2: Run the copied tests to confirm the copy is intact**

Run: `node --test ~/.claude/skills/review-gate/scripts/floor.test.mjs ~/.claude/skills/review-gate/scripts/check-record.test.mjs`
Expected: `ℹ tests 30`, `ℹ pass 30`, `ℹ fail 0` (8 + 22, same suites as Tasks 1–2).

- [ ] **Step 3: Write the Claude Code mirror of the skill**

Take Task 11's `SKILL.md` body verbatim, with these substitutions:
- Every `task` tool reference → `Task` tool (Claude Code's capitalised tool name, consistent with `fdbrp-sme.md`'s `tools:` list which includes `Task`).
- The "Model diversity (OMP side)" paragraph in Step 3 → replace with: "**Model diversity (Claude Code side):** every reviewer agent in this mirror uses `model: sonnet` (Task 12) — there is no cross-provider diversity available on this harness today. Rely on the design's own fallback: configured bots supply the diversity this mirror can't."
- `~/.omp/agent/agents/gate-*` / `~/.claude/agents/gate-*` path references → `~/.claude/agents/gate-*` only.
- Frontmatter unchanged (skills don't carry a `model` key in either harness).

- [ ] **Step 4: Verify the mirror's pipeline coverage**

Run: `grep -cE '^## Step (0|1|2|3|4|5|6|7|8|9|10)' ~/.claude/skills/review-gate/SKILL.md`
Expected: `11`.

- [ ] **Step 5: Commit**

```bash
git add ~/.claude/skills/review-gate/
git commit -m "feat(review-gate): mirror the review-gate skill and scripts to Claude Code"
```

---

### Task 15: Route `quality-gate` vs `review-gate` by config presence

**Files:**
- Modify: `~/.omp/agent/AGENTS.md:83-86`
- Modify: `~/.omp/agent/managed-skills/quality-gate/SKILL.md:6-13`

**Interfaces:**
- Produces: the routing rule every future session reads before running either gate.

- [ ] **Step 1: Update the AGENTS.md HARD RULE**

Current (lines 83-86):

```markdown
After finishing the code changes for any unit of work — and BEFORE declaring it complete, opening a PR, or
pushing to a protected branch (`main`/`master`/`development`) — read `skill://quality-gate` and run it.
This applies to every repo, this one included. "Unit of work" means any change to source, tests, config,
or scripts; a one-line fix counts.
```

Replace with:

```markdown
After finishing the code changes for any unit of work — and BEFORE declaring it complete, opening a PR, or
pushing to a protected branch (`main`/`master`/`development`) — check whether the repo root has
`.github/review-gate.json`. If it does, read `skill://review-gate` and run that instead. Every other repo
keeps `skill://quality-gate` as before (this one included, until it adopts a config). "Unit of work" means
any change to source, tests, config, or scripts; a one-line fix counts.
```

- [ ] **Step 2: Add the same routing note at the top of the quality-gate skill**

Current (lines 6-13):

```markdown
Run this after completing the code changes for any unit of work, **before** declaring it complete,
opening a PR, or pushing to a protected branch (`main`/`master`/`development`). It runs automated
checks, then fans out independent review agents in parallel, then verifies fixes recursively.

**MANDATORY — DO NOT SKIP.** Completing the implementation is not the end; the gate passing is.
This is a standing rule in `~/.omp/agent/AGENTS.md`, not an optional nicety.
```

Replace with:

```markdown
**Before anything else: if this repo has `.github/review-gate.json`, stop — read `skill://review-gate`
and run that instead.** This skill is for every repo that hasn't adopted the new config yet.

Run this after completing the code changes for any unit of work, **before** declaring it complete,
opening a PR, or pushing to a protected branch (`main`/`master`/`development`). It runs automated
checks, then fans out independent review agents in parallel, then verifies fixes recursively.

**MANDATORY — DO NOT SKIP.** Completing the implementation is not the end; the gate passing is.
This is a standing rule in `~/.omp/agent/AGENTS.md`, not an optional nicety.
```

- [ ] **Step 3: Verify both files route correctly**

Run: `grep -c 'review-gate.json' ~/.omp/agent/AGENTS.md ~/.omp/agent/managed-skills/quality-gate/SKILL.md`
Expected: at least one match in each file.

- [ ] **Step 4: Commit**

```bash
git add ~/.omp/agent/AGENTS.md ~/.omp/agent/managed-skills/quality-gate/SKILL.md
git commit -m "feat(review-gate): route quality-gate vs review-gate by .github/review-gate.json presence"
```

---

## Self-review

**Spec coverage** (design doc → task):
- Pipeline steps 0–10 → Task 11 (one `## Step N` section each, verified by the grep in Task 11 Step 2).
- Config file contract (incl. `humanApproval`) → Task 1 (`DEFAULT_CONFIG`), Task 11 Step 10, Global Constraints.
- Rule-floor script contract → Task 1, verified CLI output against the design's example shape.
- Gate record contract → Task 11 Step 9, exact field-for-field match with the design's JSON.
- Record check contract (incl. `pull_request_target` / base-ref invariant) → Task 2, with the invariant documented as a code comment plus Global Constraints and Task 11's "Enforcement note."
- Tiers / voting panel / round budgets → Task 11 Step 3 table, matches the design's Tiers table exactly.
- Security-impact-adds-specialist table → Task 11 Step 3.
- Human-required categories (core four + repo-extensible) → Task 1 (`CORE_RULES`, `DEPENDENCY_MANIFEST_BASENAMES`, `humanRequiredAdd`).
- Bots → Task 11 Step 2.
- Enforcement (local loop + CI check) → Task 2, Task 11.
- Changes to existing rules (specialists get diff-scope + config, quality-gate/AGENTS.md routing) → Tasks 10, 13, 15.
- Where it lives (user-level core + Claude mirror) → Tasks 3–14 file structure.
- App-wide audit, Refract rollout, RepeatPlus port, bot installation → explicitly excluded in "Not in this plan."

**Placeholder scan:** no "TBD"/"TODO"/"handle edge cases" language; every code step shows the real, test-verified source; every agent step shows the full file body, not a "same as Task N" reference (Task 12 reuses the OMP bodies by explicit mechanical substitution rule rather than copy-pasting six more multi-page files, which is the one place this plan asks the implementer to combine two already-fully-specified documents rather than typing a seventh near-duplicate from scratch).

**Type/name consistency:** `computeFloor`'s return shape (`risk, security, areas, humanRequired, changedLines, splitRecommended`) is the same object Task 2's `evaluateRecord` consumes as `floor`, and the same field names Task 11's skill reads; `evaluateRecord`'s `{ comment, prHeadSha, floor, labels, humanApproval }` signature is used identically in Task 2's CLI `main()` and its tests; agent names (`gate-classifier`, `gate-generalist`, `gate-spec-keeper`, `gate-adversary`, `gate-maintainer`, `gate-operator`, `gate-refuter`) are spelled identically across Tasks 3–14 and the skill.
