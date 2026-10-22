// Post-merge worktree reap (issue #658). Dry run by default; `--apply` acts; `--check` is the
// start-of-wave guard. See `.omp/skills/worktree-reap/SKILL.md` for the lane lifecycle.
//
// Usage: node scripts/worktrees-reap.mjs [--apply | --check] [--repo <path>] [--root <path>]
//          [--registry <path>]
//   --check exits 1 when the worktrees folder holds more than MAX_WORKTREES worktrees or its
//   drive has under MIN_FREE_GB free; it never deletes anything.
// Test-only: REAP_PR_FIXTURE=<json file mapping branch -> {state, headRefOid} (or an array of
//   those)> replaces the `gh` lookup; see scripts/worktrees-reap-fixture.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_WORKTREES = 8
const MIN_FREE_GB = 20

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const git = (cwd, gitArgs) =>
  spawnSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8', windowsHide: true })
const gitOut = (cwd, gitArgs) => {
  const r = git(cwd, gitArgs)
  return r.status === 0 ? r.stdout.trim() : null
}

// Two paths compare equal on Windows regardless of case and slash style.
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isInside = (child, parent) => norm(child).startsWith(`${norm(parent)}/`)

function defaultRepo() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const common = gitOut(here, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new Error('not inside a git repository')
  return path.dirname(common)
}

const repo = path.resolve(option('--repo') ?? defaultRepo())
const root = path.resolve(option('--root') ?? `${repo}-worktrees`)
const apply = flag('--apply')

function dataDir() {
  const override = process.env.REFRACT_DATA_DIR
  if (override && path.isAbsolute(override)) return override
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'refract-tauri')
}
const registryPath = path.resolve(option('--registry') ?? path.join(dataDir(), 'registry.json'))

// Every delete target must be strictly inside the worktrees root. Enforced in code.
function assertSafeTarget(target) {
  const forbidden = [root, repo, os.homedir()]
  const resolved = path.resolve(String(target ?? ''))
  const isDriveRoot = path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()
  if (!target || !path.isAbsolute(target) || isDriveRoot) throw new Error(`refusing target: ${target}`)
  if (forbidden.some((f) => norm(f) === norm(resolved)) || !isInside(resolved, root)) {
    throw new Error(`refusing target outside the worktrees root: ${resolved}`)
  }
  return resolved
}

function listWorktrees() {
  const out = gitOut(repo, ['worktree', 'list', '--porcelain'])
  if (out === null) throw new Error(`git worktree list failed in ${repo}`)
  const entries = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const wt = { path: '', head: '', branch: null, detached: false }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt.path = path.resolve(line.slice(9))
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5)
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'detached') wt.detached = true
    }
    if (wt.path) entries.push(wt)
  }
  return entries
}

function loadRegistry() {
  if (!fs.existsSync(registryPath)) return { paths: new Set(), note: `no registry at ${registryPath}` }
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
  return {
    paths: new Set(sessions.map((s) => s.worktreePath).filter(Boolean).map(norm)),
    note: `registry ${registryPath}: ${sessions.length} Session(s)`,
  }
}

function listProcesses() {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  if (ps.status !== 0) throw new Error(`process listing failed: ${ps.stderr}`)
  const parsed = JSON.parse(ps.stdout || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

// Own process and its ancestors (pnpm, shells) legitimately name paths; ignore them.
function ownChain(procs) {
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]))
  const parents = new Map()
  const wmi = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  for (const row of JSON.parse(wmi.stdout || '[]')) parents.set(row.ProcessId, row.ParentProcessId)
  const chain = new Set()
  for (let pid = process.pid; pid && byPid.has(pid) && !chain.has(pid); pid = parents.get(pid)) chain.add(pid)
  return chain
}

function namesPath(text, wtPath) {
  if (!text) return false
  const hay = text.replace(/\\/g, '/').toLowerCase()
  const needle = norm(wtPath)
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const next = hay[i + needle.length]
    if (next === undefined || !/[a-z0-9._-]/.test(next)) return true
  }
  return false
}

function prLookup(branch) {
  if (process.env.REAP_PR_FIXTURE) {
    const map = JSON.parse(fs.readFileSync(process.env.REAP_PR_FIXTURE, 'utf8'))
    const v = map[branch]
    return v ? (Array.isArray(v) ? v : [v]) : []
  }
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid'],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )
  return JSON.parse(out)
}

function evaluate(wt, ctx) {
  if (wt.detached || !wt.branch) return ['skip', 'detached HEAD']
  if (ctx.registry.paths.has(norm(wt.path))) return ['skip', 'registry Session']
  const cwd = norm(process.cwd())
  if (cwd === norm(wt.path) || cwd.startsWith(`${norm(wt.path)}/`)) return ['skip', 'caller cwd is inside it']
  const status = git(wt.path, ['status', '--porcelain'])
  if (status.status !== 0) return ['skip', 'git status failed']
  if (status.stdout.trim()) return ['skip', 'dirty tree']
  let prs
  try {
    prs = prLookup(wt.branch)
  } catch (err) {
    return ['skip', `PR lookup failed: ${String(err.message).split('\n')[0]}`]
  }
  const merged = prs.filter((p) => String(p.state).toUpperCase() === 'MERGED')
  if (merged.length === 0) {
    return ['skip', prs.length ? `PR ${String(prs[0].state).toLowerCase()}, not merged` : 'no PR for the branch']
  }
  const tip = gitOut(repo, ['rev-parse', `refs/heads/${wt.branch}`])
  if (!merged.some((p) => String(p.headRefOid).toLowerCase() === String(tip).toLowerCase())) {
    return ['skip', 'branch tip differs from the merged PR head']
  }
  if (String(tip).toLowerCase() !== wt.head.toLowerCase()) return ['skip', 'worktree HEAD differs from the branch tip']
  const busy = ctx.procs.find(
    (p) => !ctx.chain.has(p.ProcessId) && (namesPath(p.CommandLine, wt.path) || namesPath(p.ExecutablePath, wt.path)),
  )
  if (busy) return ['skip', `busy: process ${busy.Name} (pid ${busy.ProcessId}) names the path`]
  return ['reap', `PR${merged[0].number ? ` #${merged[0].number}` : ''} merged, clean, tip equals PR head`]
}

// A husk is what a worktree removal leaves behind: no `.git`, only node_modules.
function huskReason(dir, registered) {
  if (registered.has(norm(dir))) return null
  if (fs.existsSync(path.join(dir, '.git'))) return null
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  if (!entries.some((e) => e.name === 'node_modules')) return null
  for (const e of entries) {
    if (e.name === 'node_modules') continue
    if (!e.isDirectory() || e.isSymbolicLink() || fs.readdirSync(path.join(dir, e.name)).length) return null
  }
  const tops = [dir, path.join(dir, 'node_modules')]
  for (const top of tops) {
    for (const e of fs.readdirSync(top, { withFileTypes: true })) {
      const p = path.join(top, e.name)
      if (!fs.lstatSync(p).isSymbolicLink()) continue
      let real
      try {
        real = fs.realpathSync(p)
      } catch {
        return null
      }
      if (!isInside(real, dir)) return null
    }
  }
  return 'only node_modules, every top-level link resolves inside it'
}

function deleteHusk(dir) {
  const target = assertSafeTarget(dir)
  spawnSync('cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', target], { cwd: os.tmpdir(), windowsHide: true })
  return !fs.existsSync(target)
}

function check(worktrees) {
  const inRoot = worktrees.filter((w) => isInside(w.path, root))
  const freeGb = (() => {
    try {
      const s = fs.statfsSync(root)
      return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3
    } catch {
      return null
    }
  })()
  console.log(`worktrees under ${root}: ${inRoot.length} (limit ${MAX_WORKTREES})`)
  console.log(`free space on ${path.parse(root).root}: ${freeGb === null ? 'unknown' : `${freeGb.toFixed(1)} GB`} (minimum ${MIN_FREE_GB} GB)`)
  const problems = []
  if (inRoot.length > MAX_WORKTREES) problems.push('too many worktrees: run `pnpm worktrees:reap`')
  if (freeGb !== null && freeGb < MIN_FREE_GB) problems.push('low disk space')
  for (const p of problems) console.log(`WARN: ${p}`)
  return problems.length ? 1 : 0
}

function main() {
  if (!fs.existsSync(root)) {
    console.log(`worktrees root ${root} does not exist; nothing to do`)
    return 0
  }
  const all = listWorktrees()
  if (flag('--check')) return check(all)

  const registry = loadRegistry()
  const procs = listProcesses()
  const ctx = { registry, procs, chain: ownChain(procs) }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: repo ${repo}`)
  console.log(`worktrees root: ${root}`)
  console.log(registry.note)

  const candidates = all.filter((w) => norm(w.path) !== norm(repo) && isInside(w.path, root))
  const reap = []
  for (const wt of candidates) {
    const [verdict, reason] = evaluate(wt, ctx)
    console.log(`${verdict === 'reap' ? 'REAP' : 'SKIP'}  ${wt.path}  [${wt.branch ?? 'detached'}]  ${reason}`)
    if (verdict === 'reap') reap.push(wt)
  }

  const removed = []
  for (const wt of reap) {
    const target = assertSafeTarget(wt.path)
    if (!apply) {
      console.log(`would run: git worktree remove -- "${target}" ; git branch -D ${wt.branch}`)
      continue
    }
    console.log(`removing ${target}`)
    const r = git(repo, ['worktree', 'remove', '--', target])
    if (r.status !== 0) {
      console.log(`  skipped, busy or locked: ${(r.stderr || '').trim().split('\n')[0]}`)
      continue
    }
    removed.push(wt)
  }

  const registered = new Set(listWorktrees().map((w) => norm(w.path)))
  const husks = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    const reason = huskReason(dir, registered)
    if (reason) husks.push([dir, reason])
  }
  for (const [dir, reason] of husks) {
    if (!apply) {
      console.log(`HUSK  ${dir}  ${reason}\nwould run: rmdir /s /q "${assertSafeTarget(dir)}"`)
      continue
    }
    console.log(`deleting husk ${assertSafeTarget(dir)}`)
    console.log(deleteHusk(dir) ? '  gone' : '  STILL PRESENT')
  }

  for (const wt of removed) {
    if (/^(main|master)$/.test(wt.branch)) continue
    const r = git(repo, ['branch', '-D', wt.branch])
    console.log(r.status === 0 ? `deleted branch ${wt.branch}` : `branch ${wt.branch} not deleted: ${r.stderr.trim()}`)
  }
  console.log(
    apply
      ? `done: ${removed.length} worktree(s) removed, ${husks.length} husk(s) handled`
      : `dry run only: ${reap.length} worktree(s) and ${husks.length} husk(s) would be removed; rerun with --apply`,
  )
  return 0
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(`worktrees:reap failed: ${err.message}`)
  process.exitCode = 2
}
