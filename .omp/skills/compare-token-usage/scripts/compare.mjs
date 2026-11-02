// Scratch: side-by-side token report for one OMP (Refract) session and one Copilot session.
//
//   token-compare bench <omp-session.jsonl | "latest"> [copilot.json]
//   token-compare daily <since-date> [copilot-daily.json]
//
// copilot.json: rows exported from Copilot session_store_sql (see README.md), shape
//   [{ usage_model, calls, inp, cr, cw, outp, units }]
// Copilot `inp` includes cache reads and writes; OMP `input` excludes them.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const RATES = {
  'claude-opus-5.5': { i: 4, cw: 5, cr: 0.2, o: 20 },
  'claude-opus-5': { i: 4, cw: 5, cr: 0.2, o: 20 },
  'claude-opus-4.8': { i: 4, cw: 5, cr: 0.2, o: 20 },
  'claude-sonnet-5.5': { i: 2, cw: 2.5, cr: 0.2, o: 10 },
  'claude-sonnet-5': { i: 2, cw: 2.5, cr: 0.2, o: 10 },
}
const MULTIPLIER = m => (/opus/.test(m) ? 15 : 1)
const root = join(homedir(), '.omp', 'agent', 'sessions')

function* walk(dir, since = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, since)
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) yield p
  }
}

async function ompRows(files, sinceMs = 0, byDay = false) {
  const acc = new Map()
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const m = o.message ?? o
      if (m.role !== 'assistant' || !m.usage) continue
      const ts = Date.parse(o.timestamp ?? m.timestamp)
      if (!(ts >= sinceMs)) continue
      const key = byDay ? new Date(ts).toISOString().slice(0, 10) : m.model
      const u = m.usage
      const r = acc.get(key) ?? { key, calls: 0, fresh: 0, cw: 0, cr: 0, out: 0, units: 0, ompCost: 0 }
      r.calls++; r.fresh += u.input ?? 0; r.cw += u.cacheWrite ?? 0; r.cr += u.cacheRead ?? 0; r.out += u.output ?? 0
      r.units += MULTIPLIER(m.model ?? ''); r.ompCost += u.cost?.total ?? 0
      r.model = m.model
      acc.set(key, r)
    }
  }
  return [...acc.values()]
}

function copilotRows(file) {
  return JSON.parse(readFileSync(file, 'utf8')).map(x => ({
    key: x.d ?? x.usage_model, model: x.usage_model, calls: +x.calls, fresh: Math.max(0, x.inp - x.cr - x.cw),
    cw: +x.cw, cr: +x.cr, out: +x.outp, units: +x.units,
  }))
}

const price = r => {
  const R = RATES[r.model]
  return R ? (r.fresh * R.i + r.cw * R.cw + r.cr * R.cr + r.out * R.o) / 1e6 : NaN
}
const sum = rows => rows.reduce((a, r) => {
  for (const k of ['calls', 'fresh', 'cw', 'cr', 'out', 'units']) a[k] += r[k]
  a.usd += price(r) || 0
  return a
}, { calls: 0, fresh: 0, cw: 0, cr: 0, out: 0, units: 0, usd: 0 })
const n = x => Math.round(x).toLocaleString('en-GB')

function table(cols) {
  const rows = [['', ...cols.map(c => c.name)],
    ['Model calls', ...cols.map(c => n(c.t.calls))],
    ['Fresh input tokens', ...cols.map(c => n(c.t.fresh))],
    ['Cache-write tokens', ...cols.map(c => n(c.t.cw))],
    ['Cache-read tokens', ...cols.map(c => n(c.t.cr))],
    ['Output tokens', ...cols.map(c => n(c.t.out))],
    ['Context per call', ...cols.map(c => n((c.t.fresh + c.t.cw + c.t.cr) / Math.max(1, c.t.calls)))],
    ['List price (USD)', ...cols.map(c => '$' + c.t.usd.toFixed(2))],
    ['Premium units', ...cols.map(c => n(c.t.units))]]
  for (const r of rows) console.log('| ' + r.join(' | ') + ' |')
}

const [mode, a, b] = process.argv.slice(2)
if (mode === 'bench') {
  let file = a
  if (a === 'latest') {
    // Side logs such as __advisor.jsonl live in a folder named after the main session; skip them here.
    const hits = [...walk(root, Date.now() - 86400000)]
      .filter(f => !basename(f).startsWith('__') && readFileSync(f, 'utf8').includes('BENCHMARK COMPLETE'))
    file = hits.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0]
    if (!file) throw new Error('No OMP session in the last 24 h contains BENCHMARK COMPLETE')
    console.log('OMP session:', file)
  }
  const sideDir = file.replace(/\.jsonl$/, '')
  const sideLogs = existsSync(sideDir) ? [...walk(sideDir)] : []
  if (sideLogs.length) console.log('Side logs included:', sideLogs.map(f => basename(f)).join(', '))
  const omp = await ompRows([file, ...sideLogs])
  const cols = [{ name: 'Refract/OMP', t: sum(omp) }]
  if (b) cols.push({ name: 'Copilot', t: sum(copilotRows(b)) })
  table(cols)
  console.log('\nOMP by model:', omp.map(r => `${r.model} ${r.calls} calls`).join(', '))
} else if (mode === 'daily') {
  const since = Date.parse(a)
  const days = await ompRows(walk(root, since), since, true)
  const cop = (b ? copilotRows(b) : []).filter(r => String(r.key).slice(0, 10) >= a.slice(0, 10))
  console.log('| Day | OMP calls | OMP ctx/call | OMP USD | OMP units | Copilot calls | Copilot ctx/call | Copilot USD | Copilot units |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  const keys = [...new Set([...days.map(d => d.key), ...cop.map(c => String(c.key).slice(0, 10))])].sort()
  for (const k of keys) {
    const o = sum(days.filter(d => d.key === k).map(d => ({ ...d, model: d.model })))
    o.usd = days.filter(d => d.key === k).reduce((x, d) => x + d.ompCost, 0)
    const c = sum(cop.filter(r => String(r.key).startsWith(k)))
    const ctx = t => n((t.fresh + t.cw + t.cr) / Math.max(1, t.calls))
    console.log(`| ${k} | ${n(o.calls)} | ${ctx(o)} | $${o.usd.toFixed(0)} | ${n(o.units)} | ${n(c.calls)} | ${ctx(c)} | $${c.usd.toFixed(0)} | ${n(c.units)} |`)
  }
} else {
  console.log('Usage: token-compare bench <omp.jsonl|latest> [copilot.json] | daily <since> [copilot-daily.json]')
}
