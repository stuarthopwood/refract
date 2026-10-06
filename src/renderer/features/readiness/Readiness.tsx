import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import refractHero from '@/assets/brand/refract-hero.svg'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import type { Check, DependencyInstallProgress, IpcError, Readiness as ReadinessChecks } from '../../../shared/ipc'
import { useAccountsStore, useHealthStore, useInstallProgressStore } from '@/state'
import type { GithubStatus } from '@/state'
import { CHECK_LABELS, CHECK_ORDER, CheckRow } from './CheckRow'

type InstallableDependency = 'git' | 'omp' | 'github-cli'

// Order the Install-focus-restoration effect walks when one row's button disappears and another
// still needs attention (docs/DESIGN.md "First run and empty states") -- same visual order the
// checklist renders in.
const INSTALL_ORDER: InstallableDependency[] = ['git', 'omp', 'github-cli']

// Spec 006 research.md decision 10: 'ompSignedIn' has no Install action -- OMP's sign-in step
// stays a manual hand-off (FR-009), so it is left out of this map entirely.
const INSTALL_DEPENDENCY: Partial<Record<(typeof CHECK_ORDER)[number], InstallableDependency>> = {
  git: 'git',
  omp: 'omp'
}

const DEPENDENCY_LABEL: Record<InstallableDependency, string> = {
  git: 'Git',
  omp: 'OMP',
  'github-cli': 'GitHub CLI'
}

// Quality-gate remediation (UI Medium "failure detail is raw stderr ... no install manually
// link"): the same vendor domains dependencyInstall.ts's own fixed download hosts already point
// at (api.github.com/.../git-for-windows, .../cli, omp.sh), never an invented URL.
const MANUAL_INSTALL_HINT: Record<InstallableDependency, string> = {
  git: 'Or install Git for Windows yourself from gitforwindows.org.',
  omp: 'Or install omp yourself from omp.sh.',
  'github-cli': 'Or install the GitHub CLI yourself from cli.github.com.'
}

function checksFromError(error: IpcError): ReadinessChecks {
  const failed: Check = { ok: false, hint: error.message }
  return { git: failed, omp: failed, ompSignedIn: failed, github: failed }
}

export interface ReadinessProps {
  /** Seeds the checklist without calling the real API; only used to drive screenshot verification. */
  initialChecks?: ReadinessChecks
  /** Called whenever the all-checks-pass state changes, so the app shell can decide what to show. */
  onReadyChange?: (ready: boolean) => void
}

interface RowRenderState {
  action?: ReactNode
  progress?: ReactNode
  hideHint?: boolean
  iconOverride?: 'neutral'
  wordOverride?: string
}

// Quality-gate remediation (UI Medium "Progress and failure text prefixed with the dependency
// name", "one outcome line per row"): one function builds the single outcome line an Install
// action's own progress ever shows, so a row never stacks this under the ordinary check.hint
// line too -- callers pass the result as both CheckRow's progress slot and hideHint: true.
function installOutcomeText(dependency: InstallableDependency, progress?: DependencyInstallProgress): ReactNode {
  if (!progress) return null
  const name = DEPENDENCY_LABEL[dependency]
  if (progress.phase === 'downloading') {
    return <span className="text-xs text-muted-foreground">{name}: downloading…</span>
  }
  if (progress.phase === 'running') {
    return <span className="text-xs text-muted-foreground">{name}: installing…</span>
  }
  if (progress.phase === 'done') {
    return progress.restartRequired ? (
      <span className="text-xs text-muted-foreground">{name}: installed. Restart Refract to finish.</span>
    ) : (
      <span className="text-xs text-muted-foreground">{name}: installed.</span>
    )
  }
  return (
    <span role="alert" className="text-xs text-destructive">
      {name}: {progress.detail ?? 'Install failed.'} {MANUAL_INSTALL_HINT[dependency]}
    </span>
  )
}

const CHECK_RUN_FAILED_STATE: RowRenderState = {
  hideHint: true,
  iconOverride: 'neutral',
  wordOverride: 'Could not check',
  progress: <span role="status" className="text-xs text-muted-foreground">Could not check. Choose Re-check.</span>
}

// Quality-gate remediation (UI/A11y High "Install is offered when gh is only signed out",
// "Install is offered when the check itself failed to run", "after a Git/GitHub CLI install the
// row contradicts itself"): the single state machine every installable row (required or
// optional) goes through, replacing the old "show Install whenever !check.ok" rule.
function requiredRowState(
  dependency: InstallableDependency,
  check: Check | undefined,
  progress: DependencyInstallProgress | undefined,
  checkRunFailed: boolean,
  onInstall: (dependency: InstallableDependency) => void,
  buttonRef: Ref<HTMLButtonElement>
): RowRenderState {
  if (checkRunFailed) return CHECK_RUN_FAILED_STATE
  if (progress?.phase === 'done' && progress.restartRequired) {
    return { hideHint: true, iconOverride: 'neutral', wordOverride: 'Installed, restart needed', progress: installOutcomeText(dependency, progress) }
  }
  if (progress?.phase === 'done') {
    return { hideHint: true, progress: installOutcomeText(dependency, progress) }
  }
  if (!check || check.ok) return {}
  const outcome = installOutcomeText(dependency, progress)
  return {
    hideHint: Boolean(outcome),
    progress: outcome,
    action: <InstallButton dependency={dependency} progress={progress} buttonRef={buttonRef} onInstall={() => onInstall(dependency)} />
  }
}

// GitHub CLI's own Install action never shows for "installed but signed out" (research.md
// decision 10's optional row has its own ground truth for "is the CLI actually on PATH" --
// useAccountsStore's githubStatus, already derived independently from accounts.github.list(),
// rather than guessing from readiness.ts's own hint text).
function optionalRowState(
  check: Check | undefined,
  progress: DependencyInstallProgress | undefined,
  checkRunFailed: boolean,
  githubStatus: GithubStatus,
  onInstall: (dependency: InstallableDependency) => void,
  buttonRef: Ref<HTMLButtonElement>,
  onRecheck: () => void
): RowRenderState {
  if (checkRunFailed) return CHECK_RUN_FAILED_STATE
  if (progress?.phase === 'done' && progress.restartRequired) {
    return { hideHint: true, iconOverride: 'neutral', wordOverride: 'Installed, restart needed', progress: installOutcomeText('github-cli', progress) }
  }
  if (progress?.phase === 'done') {
    return { hideHint: true, progress: installOutcomeText('github-cli', progress) }
  }
  if (!check || check.ok) return {}
  const busy = progress?.phase === 'downloading' || progress?.phase === 'running'
  if (githubStatus === 'missing-cli' || busy || progress?.phase === 'failed') {
    const outcome = installOutcomeText('github-cli', progress)
    return {
      iconOverride: 'neutral',
      wordOverride: 'Optional, not set up',
      hideHint: true,
      progress: outcome ?? <span className="text-xs text-muted-foreground">Not set up.</span>,
      action: <InstallButton dependency="github-cli" progress={progress} buttonRef={buttonRef} variant="ghost" onInstall={() => onInstall('github-cli')} />
    }
  }
  if (githubStatus === 'signed-out') {
    return {
      iconOverride: 'neutral',
      wordOverride: 'Optional, signed out',
      hideHint: true,
      progress: <span className="text-xs text-muted-foreground">Signed out. Run gh auth login, then Re-check.</span>,
      action: (
        <Button size="xs" variant="ghost" className="h-6 px-1.5 text-xs" onClick={onRecheck}>
          Re-check
        </Button>
      )
    }
  }
  return {
    iconOverride: 'neutral',
    wordOverride: githubStatus === 'loading' ? 'Optional, checking' : 'Optional, could not check',
    hideHint: true,
    progress: <span className="text-xs text-muted-foreground">Could not check. Choose Re-check.</span>
  }
}

// The first-run checklist (docs/DESIGN.md "First run and empty states", FR-036): git found, OMP
// found on the supported version, OMP signed in, and (spec 006) an optional GitHub CLI row with
// its own Install action, grouped separately below a divider. One primary Add repository action,
// disabled until the three required checks pass (research.md decision 10: a missing/signed-out
// GitHub CLI never blocks it). Per-row rendering lives in CheckRow.tsx (spec 008 T024), shared
// with the profile menu's Health check dialog.
export function Readiness({ initialChecks, onReadyChange }: ReadinessProps) {
  const [checks, setChecks] = useState<ReadinessChecks | null>(initialChecks ?? null)
  const [checking, setChecking] = useState(false)
  // Quality-gate remediation (A11y/UI High "Install is offered when the check itself failed to
  // run"): distinct from a per-row check.ok failure -- true only when the WHOLE readiness.check()
  // invocation itself errored (Result-level or thrown), in which case every row is unreliable and
  // none should offer Install.
  const [checkRunFailed, setCheckRunFailed] = useState(false)
  const progress = useInstallProgressStore((state) => state.progress)
  const githubStatus = useAccountsStore((state) => state.githubStatus)

  const cardRef = useRef<HTMLDivElement>(null)
  const gitButtonRef = useRef<HTMLButtonElement>(null)
  const ompButtonRef = useRef<HTMLButtonElement>(null)
  const githubButtonRef = useRef<HTMLButtonElement>(null)
  const gitContentRef = useRef<HTMLDivElement>(null)
  const ompContentRef = useRef<HTMLDivElement>(null)
  const githubContentRef = useRef<HTMLDivElement>(null)
  const contentRefs: Record<InstallableDependency, RefObject<HTMLDivElement | null>> = {
    git: gitContentRef,
    omp: ompContentRef,
    'github-cli': githubContentRef
  }
  const prevInstallVisibleRef = useRef<Partial<Record<InstallableDependency, boolean>>>({})

  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.refract.readiness.check()
      if (result.ok) {
        setChecks(result.value)
        setCheckRunFailed(false)
        useHealthStore.getState().setOmpCheck(result.value.omp)
        useInstallProgressStore.getState().clearPassing(result.value)
      } else {
        setChecks(checksFromError(result.error))
        setCheckRunFailed(true)
      }
    } catch (error) {
      console.debug('[refract] readiness.check: invoke failed', error)
      const failed: Check = { ok: false }
      setChecks({ git: failed, omp: failed, ompSignedIn: failed, github: failed })
      setCheckRunFailed(true)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!initialChecks) void runCheck()
    // Runs once on mount; 'initialChecks' and 'runCheck' are stable for the lifetime of a screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // contracts/ipc.md: main's own automatic re-check once an Install action finishes (the
    // caller never needs to poll for it). install-progress-store.ts / init-stores.ts separately
    // subscribe to this same event globally, so a dependency's progress and health-store's
    // omp-version warning stay accurate even while this screen is unmounted; this listener only
    // needs to keep THIS screen's own 'checks' state current.
    const offChanged = window.refract.onReadinessChanged((nextChecks) => {
      setChecks(nextChecks)
      setCheckRunFailed(false)
    })
    return () => {
      offChanged()
    }
    // Subscribes once for the lifetime of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allPass = checks !== null && CHECK_ORDER.every((key) => checks[key].ok)

  useEffect(() => {
    onReadyChange?.(allPass)
  }, [allPass, onReadyChange])

  const install = useCallback(async (dependency: InstallableDependency) => {
    const store = useInstallProgressStore.getState()
    store.setProgress({ dependency, phase: 'downloading' })
    try {
      const result = await window.refract.readiness.installDependency(dependency)
      if (!result.ok) {
        store.setProgress({ dependency, phase: 'failed', detail: result.error.message })
      }
    } catch (error) {
      console.debug('[refract] readiness.installDependency: invoke failed', error)
      store.setProgress({ dependency, phase: 'failed', detail: 'The install could not run. Try Install again.' })
    }
  }, [])

  const gitState = requiredRowState('git', checks?.git, progress.git, checkRunFailed, install, gitButtonRef)
  const ompState = requiredRowState('omp', checks?.omp, progress.omp, checkRunFailed, install, ompButtonRef)
  const ompSignedInState: RowRenderState = checkRunFailed ? CHECK_RUN_FAILED_STATE : {}
  const githubState = optionalRowState(
    checks?.github,
    progress['github-cli'],
    checkRunFailed,
    githubStatus,
    install,
    githubButtonRef,
    () => void runCheck()
  )
  const ROW_STATE: Record<(typeof CHECK_ORDER)[number], RowRenderState> = {
    git: gitState,
    omp: ompState,
    ompSignedIn: ompSignedInState
  }

  // Quality-gate remediation (A11y High "Install buttons: keyboard focus is lost as soon as
  // busy becomes true, and again when the install finishes, because disabled={busy}... Nothing
  // moves focus back to a sensible place after success or failure"): the same "did the control
  // that just disappeared have focus" proxy AppearanceSection.tsx's own Save/Cancel-disabled
  // effect already relies on -- removing a focused element always drops focus to <body>
  // synchronously, so by the time this effect runs (after that commit) checking
  // document.activeElement === document.body is the only reliable signal that SOMETHING here
  // just lost focus, not which specific button it was.
  useEffect(() => {
    const visible: Partial<Record<InstallableDependency, boolean>> = {
      git: Boolean(gitState.action),
      omp: Boolean(ompState.action),
      'github-cli': Boolean(githubState.action)
    }
    const prev = prevInstallVisibleRef.current
    if (document.activeElement === document.body) {
      for (const dependency of INSTALL_ORDER) {
        if (prev[dependency] && !visible[dependency]) {
          const ownTarget = contentRefs[dependency].current
          if (ownTarget) {
            ownTarget.focus()
          } else {
            const nextInstall = cardRef.current?.querySelector<HTMLButtonElement>('[data-install-button]')
            if (nextInstall) nextInstall.focus()
            else document.querySelector<HTMLButtonElement>('[data-add-repository-trigger]')?.focus()
          }
          break
        }
      }
    }
    prevInstallVisibleRef.current = visible
  })

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-4">
        <img src={refractHero} alt="" aria-hidden className="h-16 w-16 shrink-0" />
        <div className="flex flex-col">
          <span className="font-brand text-5xl font-bold leading-none text-foreground">Refract</span>
          <span className="font-brand mt-1 text-sm font-medium leading-tight tracking-wide text-muted-foreground">One Pi, every angle.</span>
        </div>
      </div>
      <div ref={cardRef} className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-card-foreground">
        <h1 className="text-base font-medium">Get Refract ready</h1>
        <p className="mt-2 text-sm text-muted-foreground">Refract checks these before a repository can be added.</p>
        <ul aria-label="Readiness checklist" aria-live="polite" className="mt-4 flex flex-col gap-3">
          {CHECK_ORDER.map((key) => {
            const check = checks?.[key]
            const dependency = INSTALL_DEPENDENCY[key]
            const state = ROW_STATE[key]
            return (
              <CheckRow
                key={key}
                label={CHECK_LABELS[key]}
                check={check}
                checking={checking && checks === null}
                action={state.action}
                progress={state.progress}
                hideHint={state.hideHint}
                iconOverride={state.iconOverride}
                wordOverride={state.wordOverride}
                contentRef={dependency ? contentRefs[dependency] : undefined}
              />
            )
          })}
        </ul>
        <div className="mt-5 border-t border-border pt-4">
          <Badge variant="outline" className="mb-2">Optional</Badge>
          <ul aria-label="Optional checks" aria-live="polite" className="flex flex-col gap-3">
            <CheckRow
              label="GitHub CLI found, signed in"
              check={checks?.github}
              checking={checking && checks === null}
              action={githubState.action}
              progress={githubState.progress}
              hideHint={githubState.hideHint}
              iconOverride={githubState.iconOverride}
              wordOverride={githubState.wordOverride}
              contentRef={githubContentRef}
            />
          </ul>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <AddRepositoryDialog
            trigger={
              <Button data-add-repository-trigger disabled={!allPass} className="flex-1" aria-disabled={!allPass}>
                Add repository
              </Button>
            }
          />
          <Button variant="outline" onClick={() => void runCheck()} disabled={checking}>
            {checking && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            Re-check
          </Button>
        </div>
      </div>
    </div>
  )
}

function InstallButton({
  dependency,
  progress,
  onInstall,
  buttonRef,
  variant = 'outline'
}: {
  dependency: InstallableDependency
  progress?: DependencyInstallProgress
  onInstall: () => void
  buttonRef?: Ref<HTMLButtonElement>
  variant?: 'outline' | 'ghost'
}): ReactNode {
  // Quality-gate remediation (A11y High): aria-disabled, not disabled, plus an onClick guard --
  // disabled would drop keyboard focus off the button the instant an install starts (the repo's
  // own convention, SessionList.tsx/MessageInput.tsx/HealthCheckDialog.tsx).
  const busy = progress?.phase === 'downloading' || progress?.phase === 'running'
  return (
    <Button
      ref={buttonRef}
      size="sm"
      variant={variant}
      data-install-button
      aria-label={`Install ${DEPENDENCY_LABEL[dependency]}`}
      aria-disabled={busy || undefined}
      className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
      onClick={() => {
        if (!busy) onInstall()
      }}
    >
      {busy && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
      Install
    </Button>
  )
}
