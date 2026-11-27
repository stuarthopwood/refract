// Renders the release plan model (built in plan-html.mjs) into one self-contained HTML page.
// Every GitHub-sourced string goes through esc(); issue titles are attacker-reachable text.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESC[c]);

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#4d5560;--line:#d0d7de;--link:#0b57d0;--panel:#f6f8fa;--ok:#1a7f37;--bad:#b42318;--track:#d0d7de}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#a0aab6;--line:#30363d;--link:#6cb6ff;--panel:#161b22;--ok:#3fb950;--bad:#ff8a80;--track:#30363d}}
body{margin:0 auto;max-width:72rem;padding:1.5rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
a{color:var(--link)}h1{margin:0 0 .25rem}h2{margin:2.5rem 0 .75rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}h3{margin:1.5rem 0 .25rem}
.muted{color:var(--muted)}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bar{height:.75rem;background:var(--track);border-radius:.375rem;overflow:hidden;max-width:32rem}.bar span{display:block;height:100%;background:var(--ok)}
.val{display:block;margin:.25rem 0 .5rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem;font-size:.9rem}
th,td{border:1px solid var(--line);padding:.3rem .5rem;text-align:left;vertical-align:top}th{background:var(--panel)}
.verdict{border:2px solid var(--line);border-radius:.5rem;padding:.5rem .75rem;background:var(--panel)}
.fits{border-color:var(--ok)}.misses{border-color:var(--bad)}.tag{font-weight:600}
`;

const link = (repo, number) => `<a href="https://github.com/${esc(repo)}/issues/${Number(number)}">#${Number(number)}</a>`;

function bar(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return `<div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>`
    + `<span class="val">${done} of ${total} closed (${pct}%)</span>`;
}

function table(caption, head, rows) {
  const ths = head.map((h) => `<th scope="col">${esc(h)}</th>`).join('');
  const body = rows.map((cells) => {
    const [first, ...rest] = cells;
    return `<tr><th scope="row">${first}</th>${rest.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  }).join('\n');
  return `<table><caption class="sr">${esc(caption)}</caption><thead><tr>${ths}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

function renderHeader(m) {
  const v1Note = m.v1Exists
    ? (m.v1.total === 0 ? '<p>The v1 milestone exists but has no issues yet; v1 is treated as empty.</p>' : '')
    : '<p><strong>The v1 milestone does not exist yet</strong>, so v1 is treated as empty.</p>';
  return `<header><h1>Refract plan</h1>
<p class="muted">Generated ${esc(m.generated)} from live GitHub data for ${esc(m.repo)}. v1 ships by ${esc(m.deadline)}: <strong>${m.daysLeft} days left</strong>.</p>
<h2>v1 progress</h2>${bar(m.v1.closed, m.v1.total)}${v1Note}</header>`;
}

function renderForecast(m) {
  const f = m.forecast;
  const rows = f.weeks.map((w) => [esc(w.start), String(w.count)]);
  const avg = String(f.rate);
  let verdict;
  if (f.remaining === 0) verdict = ['fits', 'no open v1 issues remain.'];
  else if (f.rate === 0) verdict = ['misses', `no completed issues in the last 2 full weeks, so ${f.remaining} open v1 issues cannot be forecast and v1 does not fit.`];
  else if (f.weeksNeeded <= f.weeksLeft) verdict = ['fits', `v1 fits. ${f.remaining} open issues need ${f.weeksNeeded.toFixed(1)} weeks at ${avg}/week; ${f.weeksLeft.toFixed(1)} weeks are left.`];
  else verdict = ['misses', `v1 does not fit. ${f.remaining} open issues need ${f.weeksNeeded.toFixed(1)} weeks at ${avg}/week; only ${f.weeksLeft.toFixed(1)} weeks are left.`];
  return `<section><h2>Forecast</h2>
<p>Completed issues per ISO week (Monday start), last 4 full weeks. Projection rate: <strong>${avg} per week</strong>. Remaining open v1 issues: <strong>${f.remaining}</strong>.</p>
<p class="muted">The projection uses the last two full weeks because earlier weeks include bulk triage closes.</p>
${table('Completed issues per week', ['Week starting', 'Completed'], rows)}
<p class="verdict ${verdict[0]}"><span class="tag">Projection.</span> ${esc(verdict[1])}</p></section>`;
}

function renderGroup(m, section, g) {
  const title = g.epic ? `${link(m.repo, g.epic.number)} ${esc(g.epic.title)}` : 'No epic';
  const intro = g.epic ? '' : '<p class="muted">Not a sub-issue of any epic yet.</p>';
  const rows = g.issues.map((i) => [link(m.repo, i.number), esc(i.title), esc(i.priority ?? 'none'), esc(i.type ?? ''), esc(i.state.toLowerCase())]);
  return `<h3>${title}</h3>${intro}
${table(`${section.title} issues in ${g.epic ? g.epic.title : 'no epic'}`, ['Issue', 'Title', 'Priority', 'Type', 'State'], rows)}`;
}

function renderSection(m, s) {
  const groups = s.groups.map((g) => renderGroup(m, s, g)).join('\n');
  return `<section><h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p>${groups || '<p class="muted">No issues.</p>'}</section>`;
}

export function renderPage(m) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Refract plan</title><style>${CSS}</style></head>
<body>${renderHeader(m)}
<main>${renderForecast(m)}
${m.sections.map((s) => renderSection(m, s)).join('\n')}</main></body></html>
`;
}
