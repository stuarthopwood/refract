// Project picker helpers for the Usage view: a Project is chosen by id but only ever shown by name.
import type { UsageFilters, UsageProjectOption } from '../../shared/ipc-usage'

/**
 * Display text per Project id. Two Projects that share a name are told apart by "(removed)" for one
 * that is no longer registered, then by a number; an id is never shown.
 */
export function projectLabels(projects: UsageProjectOption[]): Map<string, string> {
  const byName = new Map<string, UsageProjectOption[]>()
  for (const project of projects) byName.set(project.name, [...(byName.get(project.name) ?? []), project])
  const labels = new Map<string, string>()
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0]!.id, name)
      continue
    }
    const seen = new Map<string, number>()
    for (const project of group) {
      const base = project.removed ? `${name} (removed)` : name
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      labels.set(project.id, count === 1 ? base : `${base} (${count})`)
    }
  }
  return labels
}

/** The saved filters with a Project filter dropped when the id has no recorded name. */
export function withKnownProject(filters: UsageFilters, projects: UsageProjectOption[]): UsageFilters {
  if (!filters.project || projects.some((p) => p.id === filters.project)) return filters
  return { ...filters, project: null }
}
