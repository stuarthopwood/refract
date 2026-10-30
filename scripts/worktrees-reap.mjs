// Post-merge worktree reap (#658). Dry run by default; `--apply` acts; `--check` guards wave start.
// Usage: node scripts/worktrees-reap.mjs [--apply | --check] [--repo <path>] [--root <path>] [--registry <path>] [--no-registry]
// Exit: 0 ok; 1 --check problem or --apply failure; 2 bad usage, refused (--apply needs a registry unless --no-registry), or crash.
// --pr-fixture <json> replaces the `gh` lookup; honoured only when --root and --repo are under the OS temp dir.
// node_modules goes first via `rmdir /s /q` on a \\?\ path because git cannot delete pnpm junctions (#1181).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_WORKTREES = 8
const MIN_FREE_GB = 20
// Ignored paths that are safe to lose with a worktree (rebuildable output).
const IGNORED_ALLOWED = /^(?:(?:.*\/)?node_modules\/|dist\/|out\/|\.vite\/|src-tauri\/target\/|src-tauri\/gen\/|[^/]*\.tsbuildinfo$)/
const CMD_META = /[&^%|<>"()]/
const HUSK_NAME = /^[A-Za-z0-9._-]+$/

const USAGE =
  'usage: node scripts/worktrees-reap.mjs [--apply | --check] [--repo <path>] [--root <path>] [--registry <path>] [--no-registry] [--pr-fixture <path>]'
const BOOLEAN_FLAGS = ['--apply', '--check', '--no-registry']
const VALUE_FLAGS = ['--repo', '--root', '--registry', '--pr-fixture']

const args = process.argv.slice(2)
const usageError = (msg) => {
  console.error(`worktrees:reap: ${msg}\n${USAGE}`)
  process.exit(2)
}
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.includes(args[i])) {
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) usageError(`missing value for ${args[i]}`)
    i++
  } else if (!BOOLEAN_FLAGS.includes(args[i])) usageError(`unknown argument: ${args[i]}`)
}
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

const realOrResolved = (p) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
const prFixturePath = option('--pr-fixture') ? path.resolve(option('--pr-fixture')) : null
if (prFixturePath) {
  const tmp = realOrResolved(os.tmpdir())
  if (!isInside(realOrResolved(root), tmp) || !isInside(realOrResolved(repo), tmp)) {
    console.error('worktrees:reap: --pr-fixture is test-only and needs both --root and --repo under the OS temp directory')
    process.exit(2)
  }
  console.log('*** TEST FIXTURE ACTIVE: PR state comes from --pr-fixture, not GitHub ***')
}

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
  if (flag('--no-registry')) return { paths: new Set(), note: 'WARN: --no-registry: Session protection is OFF' }
  if (!fs.existsSync(registryPath)) {
    const msg = `no registry at ${registryPath}`
    if (apply) throw new Error(`${msg}; refusing --apply (pass --no-registry to override)`)
    return { paths: new Set(), note: `WARN: ${msg}; Session protection is OFF (--apply would refuse)` }
  }
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
  if (prFixturePath) {
    const map = JSON.parse(fs.readFileSync(prFixturePath, 'utf8'))
    const v = map[branch]
    return v ? (Array.isArray(v) ? v : [v]) : []
  }
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'number,state,headRefOid'],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )
  return JSON.parse(out)
}

function evaluate(wt, ctx) {
  if (wt.detached || !wt.branch) return ['skip', 'detached HEAD']
  if (ctx.registry.paths.has(norm(wt.path))) return ['skip', 'registry Session']
  const cwd = norm(process.cwd())
  if (cwd === norm(wt.path) || cwd.startsWith(`${norm(wt.path)}/`)) return ['skip', 'caller cwd is inside it']
  const status = git(wt.path, ['status', '--porcelain', '--ignored'])
  if (status.status !== 0) return ['skip', 'git status failed']
  const lines = status.stdout.split(/\r?\n/).filter(Boolean)
  if (lines.some((l) => !l.startsWith('!! '))) return ['skip', 'dirty tree']
  const unexpected = lines.map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => !IGNORED_ALLOWED.test(p))
  if (unexpected.length) return ['skip', `ignored files present: ${unexpected.slice(0, 3).join(', ')}`]
  let prs
  try {
    prs = prLookup(wt.branch)
  } catch (err) {
    return ['skip', `PR lookup failed: ${String(err.message).split('\n')[0]}`]
  }
  const open = prs.find((p) => String(p.state).toUpperCase() === 'OPEN')
  if (open) return ['skip', `open PR${open.number ? ` #${open.number}` : ''}`]
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

// True when every file left in a deregistered worktree is allow-listed build output, so a
// file written after the eligibility check is never deleted. Links are not followed.
function onlyBuildOutput(dir) {
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        if (!IGNORED_ALLOWED.test(`${r}/`)) return false
      } else if (e.isDirectory()) {
        if (!IGNORED_ALLOWED.test(`${r}/`)) stack.push(r)
      } else if (!IGNORED_ALLOWED.test(r)) {
        return false
      }
    }
  }
  return true
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
        // A partial removal leaves junctions whose .pnpm target is already gone; judge the recorded target.
        try {
          real = path.resolve(top, fs.readlinkSync(p).replace(/^\\\\\?\\/, ''))
        } catch {
          return null
        }
      }
      if (!isInside(real, dir)) return null
    }
  }
  return 'only node_modules, every top-level link resolves inside it'
}

function cmdExe() {
  const comSpec = process.env.ComSpec
  if (comSpec && path.isAbsolute(comSpec) && /\\cmd\.exe$/i.test(comSpec)) return comSpec
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
}

function deleteHusk(dir) {
  const target = assertSafeTarget(dir)
  spawnSync(cmdExe(),  ['/d', '/c', 'rmdir', '/s', '/q', target], { cwd: os.tmpdir(), windowsHide: true })
  return !fs.existsSync(target)
}

// `git worktree remove` stops at pnpm's node_modules directory junctions on Windows (#1181);
// `rmdir /s /q` on a \\?\ path removes a junction without following it.
function deleteNodeModules(worktreePath) {
  const nm = assertSafeTarget(path.join(worktreePath, 'node_modules'))
  if (CMD_META.test(nm)) return false
  if (!fs.existsSync(nm)) return true
  spawnSync(cmdExe(), ['/d', '/c', 'rmdir', '/s', '/q', `\\\\?\\${nm}`], { cwd: os.tmpdir(), windowsHide: true })
  return !fs.existsSync(nm)
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

  let failures = 0
  const removed = []
  for (const wt of reap) {
    try {
      const target = assertSafeTarget(wt.path)
      if (!apply) {
        console.log(`would run: remove "${target}\\node_modules" via cmd rmdir (if present) ; git worktree remove -- "${target}" ; git branch -D ${wt.branch}`)
        continue
      }
      console.log(`removing ${target}`)
      if (!deleteNodeModules(target)) {
        failures++
        console.log('  FAILED: node_modules still present, busy or locked')
        continue
      }
      const r = git(repo, ['worktree', 'remove', '--', target])
      if (r.status !== 0) {
        // Git may deregister the worktree and then fail on leftovers; delete the rest only if it is all build output.
        const deregistered = !listWorktrees().some((w) => norm(w.path) === norm(target))
        if (!deregistered || !onlyBuildOutput(target) || !deleteHusk(target)) {
          failures++
          console.log(`  FAILED, busy or locked: ${(r.stderr || '').trim().split('\n')[0]}`)
          continue
        }
        console.log('  git left a deregistered leftover folder; deleted it')
      }
      removed.push(wt)
      if (/^(main|master)$/.test(wt.branch)) continue
      const b = git(repo, ['branch', '-D', wt.branch])
      if (b.status === 0) console.log(`deleted branch ${wt.branch}`)
      else {
        failures++
        console.log(`FAILED: branch ${wt.branch} not deleted: ${b.stderr.trim()}`)
      }
    } catch (err) {
      failures++
      console.log(`FAILED  ${wt.path}: ${err.message}`)
    }
  }

  const husks = []
  try {
    const registered = new Set(listWorktrees().map((w) => norm(w.path)))
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = path.join(root, e.name)
      try {
        const reason = huskReason(dir, registered)
        if (!reason) continue
        if (!HUSK_NAME.test(e.name) || CMD_META.test(root)) {
          console.log(`SKIP  ${dir}  husk, but the path has characters unsafe for cmd.exe`)
          continue
        }
        const target = assertSafeTarget(dir)
        if (!apply) {
          console.log(`HUSK  ${dir}  ${reason}\nwould run: rmdir /s /q "${target}"`)
          husks.push(dir)
          continue
        }
        console.log(`deleting husk ${target}`)
        if (deleteHusk(dir)) {
          console.log('  gone')
          husks.push(dir)
        } else {
          failures++
          console.log('  FAILED: STILL PRESENT')
        }
      } catch (err) {
        failures++
        console.log(`FAILED  husk ${dir}: ${err.message}`)
      }
    }
  } catch (err) {
    failures++
    console.log(`FAILED  husk pass: ${err.message}`)
  }

  console.log(
    apply
      ? `done: ${removed.length} worktree(s) removed, ${husks.length} husk(s) deleted, ${failures} failure(s)`
      : `dry run only: ${reap.length} worktree(s) and ${husks.length} husk(s) would be removed; rerun with --apply`,
  )
  return failures ? 1 : 0
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(`worktrees:reap failed: ${err.message}`)
  process.exitCode = 2
}
