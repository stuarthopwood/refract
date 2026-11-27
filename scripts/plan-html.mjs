#!/usr/bin/env node
// Builds docs/plan.html, the release plan page, from live GitHub data (the issues are the source of truth).
// Usage: pnpm plan:html [--out <file>]   (needs an authenticated `gh`)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function outFile() {
  const at = process.argv.indexOf('--out');
  if (at === -1) return path.join(repoRoot, 'docs', 'plan.html');
  if (!process.argv[at + 1]) throw new Error('--out needs a file path');
  return path.resolve(process.argv[at + 1]);
}

function normalise(raw) {
  const labels = (raw.labels?.nodes ?? raw.labels ?? []).map((l) => l.name);
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    priority: PRIORITIES.find((p) => labels.includes(p)) ?? null,
    type: TYPES.find((t) => labels.includes(t)) ?? null,
    milestone: raw.milestone?.title ?? null,
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

// Later releases are whatever open `vN` milestones exist; none is a valid state.
function fetchReleases() {
  const rows = gh(['api', `repos/${REPO}/milestones?state=open`, '--paginate', '--jq', '.[] | [.title, .due_on // ""] | @tsv'])
    .split('\n').filter(Boolean).map((line) => line.split('\t'));
  return rows
    .filter(([title]) => /^v\d+$/.test(title) && Number(title.slice(1)) > 1)
    .map(([title, due]) => ({ title, due: due ? due.slice(0, 10) : null }))
    .sort((a, b) => Number(a.title.slice(1)) - Number(b.title.slice(1)));
}

// Epic order is the row order of the v1 epic table that follows the "**v1 scope" paragraph in docs/PLAN.md.
function epicOrder() {
  const lines = readFileSync(path.join(repoRoot, 'docs', 'PLAN.md'), 'utf8').split('\n');
  const at = lines.findIndex((line) => line.startsWith('**v1 scope'));
  const order = [];
  for (const line of at === -1 ? [] : lines.slice(at + 1)) {
    const m = /^\|\s*#(\d+)\s*\|/.exec(line);
    if (m) order.push(Number(m[1]));
    else if (order.length > 0) break;
  }
  if (order.length === 0) console.warn('docs/PLAN.md has no v1 epic table after "**v1 scope"; epics fall back to issue number.');
  return new Map(order.map((n, i) => [n, i]));
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

// p0, p1, p2 bugs, other p2, p3, then unlabelled.
function priorityRank(issue) {
  if (issue.priority === 'p0') return 0;
  if (issue.priority === 'p1') return 1;
  if (issue.priority === 'p2') return issue.type === 'bug' ? 2 : 3;
  return issue.priority === 'p3' ? 4 : 5;
}

const byPriority = (a, b) =>
  (a.state === b.state ? 0 : a.state === 'OPEN' ? -1 : 1) || priorityRank(a) - priorityRank(b) || a.number - b.number;

function buildSections(epics, order, issues, releases) {
  const pool = new Map();
  for (const i of [...issues, ...epics.flatMap((e) => e.children)]) {
    if (!i.title.startsWith('Epic:')) pool.set(i.number, i);
  }
  const all = [...pool.values()];
  const epicOf = new Map();
  for (const e of epics) for (const c of e.children) if (!epicOf.has(c.number)) epicOf.set(c.number, e.number);
  const rank = (e) => order.get(e.number) ?? order.size;
  const ordered = [...epics].sort((a, b) => rank(a) - rank(b) || a.number - b.number);

  const groupByEpic = (list) => {
    const byEpic = new Map();
    for (const i of [...list].sort(byPriority)) {
      const key = epicOf.get(i.number) ?? null;
      byEpic.set(key, [...(byEpic.get(key) ?? []), i]);
    }
    const groups = ordered.filter((e) => byEpic.has(e.number)).map((e) => ({ epic: e, issues: byEpic.get(e.number) }));
    if (byEpic.has(null)) groups.push({ epic: null, issues: byEpic.get(null) });
    return groups;
  };

  const v1All = all.filter((i) => i.milestone === V1_MILESTONE);
  const v1Open = v1All.filter((i) => i.state === 'OPEN');
  const sections = [{
    title: V1_MILESTONE,
    summary: `${v1Open.length} open, ${v1All.length - v1Open.length} closed; ships by ${isoDate(DEADLINE)}.`,
    groups: groupByEpic(v1All),
  }];
  for (const r of releases) {
    const open = all.filter((i) => i.state === 'OPEN' && i.milestone === r.title);
    sections.push({ title: r.title, summary: `${open.length} open${r.due ? `, due ${r.due}` : ''}.`, groups: groupByEpic(open) });
  }
  const unplanned = all.filter((i) => i.state === 'OPEN' && i.milestone === null);
  if (unplanned.length > 0) {
    sections.push({ title: 'Unplanned', summary: `${unplanned.length} open issues with no milestone.`, groups: groupByEpic(unplanned) });
  }
  return { sections, v1All, v1Open };
}

function main() {
  const now = Date.now();
  const out = outFile();
  const order = epicOrder();
  const v1Exists = milestoneExists();
  const v1Issues = v1Exists
    ? ghJson(['issue', 'list', '-R', REPO, '--state', 'all', '--milestone', V1_MILESTONE, '--json', ISSUE_FIELDS, '--limit', '5000']).map(normalise)
    : [];
  const openIssues = ghJson(['issue', 'list', '-R', REPO, '--state', 'open', '--json', ISSUE_FIELDS, '--limit', '5000']).map(normalise);
  const epics = fetchEpics();
  const { sections, v1All, v1Open } = buildSections(epics, order, [...openIssues, ...v1Issues], fetchReleases());

  const weeks = weeklyThroughput(now);
  const recent = weeks.slice(-2);
  const avg = recent.reduce((sum, w) => sum + w.count, 0) / recent.length;
  const rate = avg > 0 ? Math.max(1, Math.round(avg)) : 0;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const daysLeft = Math.max(0, Math.ceil((DEADLINE - today) / DAY));
  const forecast = { weeks, rate, remaining: v1Open.length, weeksLeft: daysLeft / 7, weeksNeeded: rate > 0 ? v1Open.length / rate : Infinity };

  const html = renderPage({
    repo: REPO,
    generated: new Date(now).toISOString(),
    deadline: isoDate(DEADLINE),
    daysLeft,
    v1Exists,
    v1: { total: v1All.length, closed: v1All.length - v1Open.length },
    forecast,
    sections,
  });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  const titles = sections.map((s) => s.title).join(', ');
  console.log(`${out}: ${epics.length} epics, ${v1All.length} v1 issues (${v1Open.length} open), ${avg.toFixed(1)} completed/week; sections: ${titles}`);
}

main();
