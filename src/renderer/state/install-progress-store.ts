import { create } from 'zustand'
import type { DependencyInstallProgress, Readiness as ReadinessChecks } from '../../shared/ipc'

export type InstallableDependency = DependencyInstallProgress['dependency']

const DEPENDENCY_CHECK_KEY: Record<InstallableDependency, keyof ReadinessChecks> = {
  git: 'git',
  omp: 'omp',
  'github-cli': 'github'
}

interface InstallProgressState {
  progress: Partial<Record<InstallableDependency, DependencyInstallProgress>>
  setProgress(progress: DependencyInstallProgress): void
  /** Drops an entry the moment its own check starts passing -- readiness:changed (an automatic
   *  re-check main runs after an install finishes, or Readiness.tsx's own Re-check), never
   *  cleared otherwise (quality-gate remediation, UI Medium: 'install progress text is never
   *  cleared', left an 'Installed.' or an old failure detail sitting under a row that has since
   *  turned green). Never drops a restartRequired entry: that row keeps failing in THIS process
   *  regardless of what main's own re-check reports, so the 'Installed. Restart Refract to
   *  finish.' state has to survive until the user actually restarts. */
  clearPassing(checks: ReadinessChecks): void
  clear(dependency: InstallableDependency): void
}

// Spec 006 quality-gate remediation (UI Medium 'install progress is lost when the screen
// unmounts, and nothing blocks a second install'): a store, not Readiness.tsx's own useState, so
// a dependency's Install progress survives that screen unmounting (ready && hasRepositories) --
// the optional GitHub CLI install can still be running when that happens, and a later remount
// (the profile menu's Health check never installs, but a future Readiness re-entry would) needs
// to show the still-running/just-finished state instead of starting cold. init-stores.ts
// subscribes once, globally, to readiness:install-progress and readiness:changed so this stays
// accurate even while no screen reads it.
export const useInstallProgressStore = create<InstallProgressState>((set) => ({
  progress: {},
  setProgress: (progress) =>
    set((state) => ({ progress: { ...state.progress, [progress.dependency]: progress } })),
  clearPassing: (checks) =>
    set((state) => {
      let changed = false
      const next = { ...state.progress }
      for (const dependency of Object.keys(DEPENDENCY_CHECK_KEY) as InstallableDependency[]) {
        const entry = next[dependency]
        if (!entry || entry.restartRequired) continue
        if (checks[DEPENDENCY_CHECK_KEY[dependency]].ok) {
          delete next[dependency]
          changed = true
        }
      }
      return changed ? { progress: next } : state
    }),
  clear: (dependency) =>
    set((state) => {
      if (!(dependency in state.progress)) return state
      const next = { ...state.progress }
      delete next[dependency]
      return { progress: next }
    })
}))
