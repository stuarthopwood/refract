// Driver (not a test) that proves scripts/worktrees-reap.mjs on a scratch fixture under the OS
// temp directory: a merged clean worktree, a dirty one, an open-PR one, a registry Session, a
// husk and a busy one. Prints a before/after for the dry run and for `--apply`.
// It never touches the real worktrees folder. The scratch folder is left for inspection; the
// spawned busy process is killed by PID at the end.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const reap = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worktrees-reap.mjs')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reap658-'))
const repo = path.join(base, 'repo')
const root = `${repo}-worktrees`
const run = (cwd, cmd, a) => {
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const git = (cwd, ...a) => run(cwd, 'git', a)

fs.mkdirSync(repo)
fs.mkdirSync(root)
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'fixture@example.invalid')
git(repo, 'config', 'user.name', 'fixture')
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n')
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'init')

const names = ['a-merged-clean', 'b-merged-dirty', 'c-open-pr', 'd-registry', 'f-busy', 'g-merged-ignored']
const prs = {}
const wtPath = (n) => path.join(root, n)
for (const n of names) {
  git(repo, 'worktree', 'add', '-q', '-b', `lane/${n}`, wtPath(n), 'main')
  const tip = git(wtPath(n), 'rev-parse', 'HEAD')
  prs[`lane/${n}`] = { state: n === 'c-open-pr' ? 'OPEN' : 'MERGED', headRefOid: tip }
}
// (a) gets a node_modules with an inside-pointing junction, like pnpm leaves behind.
const nmA = path.join(wtPath('a-merged-clean'), 'node_modules')
fs.mkdirSync(path.join(nmA, 'pkg'), { recursive: true })
run(base, 'cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(nmA, 'link'), path.join(nmA, 'pkg')])
// (a) also gets a junction to a folder outside the worktree; reaping must not follow it (#1181).
const outside = path.join(base, 'outside-target')
fs.mkdirSync(outside)
fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n')
run(base, 'cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(nmA, 'outlink'), outside])
fs.writeFileSync(path.join(wtPath('b-merged-dirty'), 'a.txt'), 'dirty\n')
fs.writeFileSync(path.join(wtPath('g-merged-ignored'), '.env'), 'SECRET=1\n')

// (h) a husk whose name carries a cmd.exe metacharacter must be skipped, never deleted.
fs.mkdirSync(path.join(root, 'x&y', 'node_modules', 'pkg'), { recursive: true })

// (e) husk
const husk = path.join(root, 'e-husk')
fs.mkdirSync(path.join(husk, 'node_modules', 'pkg'), { recursive: true })
run(base, 'cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(husk, 'node_modules', 'link'), path.join(husk, 'node_modules', 'pkg')])

const prFile = path.join(base, 'prs.json')
fs.writeFileSync(prFile, JSON.stringify(prs, null, 2))
const regFile = path.join(base, 'registry.json')
fs.writeFileSync(regFile, JSON.stringify({ version: 1, repositories: [], sessions: [{ id: 's1', worktreePath: wtPath('d-registry') }] }))

const busy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', wtPath('f-busy')], {
  cwd: wtPath('f-busy'),
  stdio: 'ignore',
  windowsHide: true,
})
console.log(`fixture: ${base}\nbusy fixture process pid: ${busy.pid}`)

const snapshot = (label) => {
  console.log(`--- ${label}: git worktree list`)
  console.log(git(repo, 'worktree', 'list'))
  console.log(`--- ${label}: ${root}`)
  console.log(fs.readdirSync(root).join('\n'))
  console.log(`--- ${label}: branches`)
  console.log(git(repo, 'branch', '--format=%(refname:short)'))
}
const reapRun = (extra, env = {}) => {
  const r = spawnSync(process.execPath, [reap, '--repo', repo, '--root', root, '--registry', regFile, '--pr-fixture', prFile, ...extra], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  console.log(r.stdout + r.stderr + `exit ${r.status}`)
}

try {
  snapshot('before')
  console.log('=== dry run')
  reapRun([])
  snapshot('after dry run')
  console.log('=== apply')
  reapRun(['--apply'])
  snapshot('after apply')
  const checks = {
    'worktree a removed': !fs.existsSync(wtPath('a-merged-clean')),
    'branch lane/a-merged-clean deleted': !git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/).includes('lane/a-merged-clean'),
    'junction target kept with content': fs.existsSync(path.join(outside, 'keep.txt')),
  }
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
    if (!ok) process.exitCode = 1
  }
  console.log('=== check')
  reapRun(['--check'])
  console.log('=== negative: ambient REAP_PR_FIXTURE has no effect (no --pr-fixture; gh is used, branches are not real PRs)')
  const ambient = spawnSync(process.execPath, [reap, '--repo', repo, '--root', root, '--registry', regFile], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, REAP_PR_FIXTURE: prFile },
  })
  console.log(ambient.stdout.split('\n').filter((l) => /^(REAP|SKIP)/.test(l)).join('\n') + `\nexit ${ambient.status}`)
  console.log('=== negative: --pr-fixture with a non-temp --root refuses')
  const refused = spawnSync(process.execPath, [reap, '--repo', repo, '--root', path.dirname(reap), '--pr-fixture', prFile], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
  })
  console.log(refused.stdout + refused.stderr + `exit ${refused.status}`)
} finally {
  process.kill(busy.pid)
  console.log(`killed fixture pid ${busy.pid}`)
}
