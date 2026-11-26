#!/usr/bin/env node
// Builds docs/plan.html, the v1 plan page, from live GitHub data (the issues are the source of truth).
// Usage: pnpm plan:html   (needs an authenticated `gh`)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './plan-html-render.mjs';

const REPO = 'stuarthopwood/refract';
const [OWNER, NAME] = REPO.split('/');
const V1_MILESTONE = 'v1';
const DEADLINE = Date.UTC(2026, 11, 31);
const DAY = 86_400_000;
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
const TYPES = ['bug', 'feature', 'enhancement', 'chore', 'design', 'idea'];
const ISSUE_FIELDS = 'number,title,state,labels,milestone';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const ghJson = (args) => JSON.parse(gh(args));

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const mondayOf = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
};

function normalise(raw) {
  const labels = (raw.labels?.nodes ?? raw.labels ?? []).map((l) => l.name);
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    priority: PRIORITIES.find((p) => labels.includes(p)) ?? null,
    type: TYPES.find((t) => labels.includes(t)) ?? null,
    v1: raw.milestone?.title === V1_MILESTONE,
  };
}

const CHILD_FIELDS = 'number title state labels(first:20){nodes{name}} milestone{title}';
const SEARCH_QUERY = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){
  pageInfo{hasNextPage endCursor}
  nodes{... on Issue{number title state subIssues(first:100){pageInfo{hasNextPage endCursor} nodes{${CHILD_FIELDS}}}}}}}`;
const MORE_QUERY = `query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name){
  issue(number:$n){subIssues(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${CHILD_FIELDS}}}}}}`;

const graphql = (query, vars) => {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  return JSON.parse(gh(args)).data;
};

function fetchEpics() {
  const epics = [];
  let cursor = null;
  for (;;) {
    const { search } = graphql(SEARCH_QUERY, { q: `repo:${REPO} is:issue is:open in:title "Epic:"`, cursor });
    for (const node of search.nodes) {
      if (!node?.title?.startsWith('Epic:')) continue;
      let page = node.subIssues;
      const children = [...page.nodes];
      while (page.pageInfo.hasNextPage) {
        const more = graphql(MORE_QUERY, { owner: OWNER, name: NAME, n: node.number, cursor: page.pageInfo.endCursor });
        page = more.repository.issue.subIssues;
        children.push(...page.nodes);
      }
      epics.push({ number: node.number, title: node.title, state: node.state, children: children.map(normalise) });
    }
    if (!search.pageInfo.hasNextPage) return epics;
    cursor = search.pageInfo.endCursor;
  }
}

const milestoneExists = () =>
  gh(['api', `repos/${REPO}/milestones?state=all`, '--paginate', '--jq', '.[].title']).split('\n').includes(V1_MILESTONE);

// Queue rows are `| order | #N | ...`; the first row naming an issue sets its rank.
function queueRanks() {
  const text = readFileSync(path.join(repoRoot, 'docs', 'PLAN.md'), 'utf8');
  const start = text.indexOf('\n## Queue');
  if (start === -1) {
    console.warn('docs/PLAN.md has no "## Queue" heading; schedule ties fall back to issue number.');
    return new Map();
  }
  const end = text.indexOf('\n## ', start + 1);
  const ranks = new Map();
  for (const line of text.slice(start, end === -1 ? undefined : end).split('\n')) {
    if (!line.startsWith('|')) continue;
    const m = /^#(\d+)/.exec(line.split('|')[2]?.trim() ?? '');
    if (m && !ranks.has(Number(m[1]))) ranks.set(Number(m[1]), ranks.size);
  }
  return ranks;
}

function weeklyThroughput(now) {
  const thisMonday = mondayOf(now);
  const first = thisMonday - 28 * DAY;
  const closed = ghJson(['issue', 'list', '-R', REPO, '--state', 'closed', '--search', `closed:>=${isoDate(first)}`,
    '--json', 'title,closedAt,stateReason', '--limit', '1000']);
  const weeks = [0, 1, 2, 3].map((i) => ({ start: isoDate(first + i * 7 * DAY), count: 0 }));
  for (const issue of closed) {
    if (issue.stateReason !== 'COMPLETED' || issue.title.startsWith('Epic:')) continue;
    const at = Date.parse(issue.closedAt);
    if (at < first || at >= thisMonday) continue;
    weeks[Math.floor((at - first) / (7 * DAY))].count += 1;
  }
  return weeks;
}

function groupStats(epic, issues) {
  const open = issues.filter((i) => i.state === 'OPEN');
  return {
    epic,
    issues,
    open: open.length,
    closed: issues.length - open.length,
    v1: issues.filter((i) => i.v1).length,
    v1Open: open.filter((i) => i.v1).length,
    postV1Open: open.filter((i) => !i.v1).length,
  };
}

function buildGroups(epics, openIssues, v1Issues) {
  const owned = new Set(epics.flatMap((e) => e.children.map((c) => c.number)));
  const epicNumbers = new Set(epics.map((e) => e.number));
  const loose = new Map();
  for (const issue of [...openIssues, ...v1Issues]) {
    if (!owned.has(issue.number) && !epicNumbers.has(issue.number) && !issue.title.startsWith('Epic:')) loose.set(issue.number, issue);
  }
  const prioRank = (i) => (i.priority ? PRIORITIES.indexOf(i.priority) : PRIORITIES.length);
  const byPriority = (a, b) =>
    (a.state === b.state ? 0 : a.state === 'OPEN' ? -1 : 1) || prioRank(a) - prioRank(b) || a.number - b.number;
  const groups = epics.map((e) => groupStats(e, [...e.children].sort(byPriority)));
  groups.sort((a, b) => b.v1Open - a.v1Open || b.open - a.open || a.epic.number - b.epic.number);
  groups.push(groupStats(null, [...loose.values()].sort(byPriority)));
  return groups;
}

function scheduleRank(issue) {
  if (issue.priority === 'p0') return 0;
  if (issue.priority === 'p1') return 1;
  if (issue.priority === 'p2') return issue.type === 'bug' ? 2 : 3;
  return issue.priority === 'p3' ? 4 : 5;
}

function buildSchedule(openV1, rate, ranks, scheduleStart) {
  const sorted = [...openV1].sort((a, b) =>
    scheduleRank(a) - scheduleRank(b)
    || (ranks.get(a.number) ?? Infinity) - (ranks.get(b.number) ?? Infinity)
    || a.number - b.number);
  const buckets = [];
  if (rate > 0) {
    for (let k = 0, from = 0; from < sorted.length; k += 1) {
      const to = Math.min(sorted.length, rate * (k + 1));
      const start = scheduleStart + k * 7 * DAY;
      if (to > from) {
        buckets.push({ start: isoDate(start), end: isoDate(Math.min(start + 6 * DAY, Math.max(DEADLINE, start))), late: start > DEADLINE, issues: sorted.slice(from, to) });
      }
      from = to;
    }
  }
  return { startDate: isoDate(scheduleStart), buckets };
}

function main() {
  const now = Date.now();
  const ranks = queueRanks();
  const v1Exists = milestoneExists();
  const v1Issues = v1Exists
    ? ghJson(['issue', 'list', '-R', REPO, '--state', 'all', '--milestone', V1_MILESTONE, '--json', ISSUE_FIELDS, '--limit', '5000']).map(normalise)
    : [];
  const openIssues = ghJson(['issue', 'list', '-R', REPO, '--state', 'open', '--json', ISSUE_FIELDS, '--limit', '5000']).map(normalise);
  const epics = fetchEpics();
  const groups = buildGroups(epics, openIssues, v1Issues);

  const v1ByNumber = new Map(v1Issues.map((i) => [i.number, i]));
  for (const g of groups) for (const i of g.issues) if (i.v1) v1ByNumber.set(i.number, i);
  const allV1 = [...v1ByNumber.values()].filter((i) => !i.title.startsWith('Epic:'));
  const openV1 = allV1.filter((i) => i.state === 'OPEN');

  const weeks = weeklyThroughput(now);
  const recent = weeks.slice(-2);
  const avg = recent.reduce((sum, w) => sum + w.count, 0) / recent.length;
  // One whole-issue rate drives both the verdict and the schedule so they cannot disagree.
  const rate = avg > 0 ? Math.max(1, Math.round(avg)) : 0;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const daysLeft = Math.max(0, Math.ceil((DEADLINE - today) / DAY));
  const forecast = { weeks, rate, remaining: openV1.length, weeksLeft: daysLeft / 7, weeksNeeded: rate > 0 ? openV1.length / rate : Infinity };

  const html = renderPage({
    repo: REPO,
    generated: new Date(now).toISOString(),
    deadline: isoDate(DEADLINE),
    daysLeft,
    v1Exists,
    v1: { total: allV1.length, closed: allV1.length - openV1.length },
    forecast,
    schedule: buildSchedule(openV1, rate, ranks, mondayOf(now) + 7 * DAY),
    groups,
  });
  writeFileSync(path.join(repoRoot, 'docs', 'plan.html'), html);
  console.log(`docs/plan.html: ${epics.length} epics, ${allV1.length} v1 issues (${openV1.length} open), ${avg.toFixed(1)} completed/week`);
}

main();
