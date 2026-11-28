import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { EndedBanner } from './EndedBanner'
import { TerminalTabStrip } from './TerminalTabStrip'
import { panelDomId, tabDomId } from './terminalTabs'

// Roles and names a screen reader hears, checked on the server-rendered markup because the suite has no DOM.

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const tab = (id: string, name: string, state: TabInfo['state'] = { kind: 'running' }): TabInfo => ({ id, name, state }) as TabInfo

function strip(tabs: TabInfo[], activeTabId: string | null): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(TerminalTabStrip, { sessionId: 's1', tabs, activeTabId, adding: false, onSelect: vi.fn(), onAdd: vi.fn(), restoreFocus: () => true })
    )
  )
}

describe('terminal tab strip roles', () => {
  const html = strip([tab('a', 'Terminal 1'), tab('b', 'build', { kind: 'ended', code: 2 })], 'a')

  it('is_a_labelled_tablist_of_tabs', () => {
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Terminal tabs"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
  })

  it('marks_only_the_shown_tab_selected_and_in_the_tab_order', () => {
    const shown = html.match(/<button[^>]*id="terminal-tab-a"[^>]*>/)?.[0] ?? ''
    const other = html.match(/<button[^>]*id="terminal-tab-b"[^>]*>/)?.[0] ?? ''
    expect(shown).toContain('aria-selected="true"')
    expect(shown).toContain('tabindex="0"')
    expect(other).toContain('aria-selected="false"')
    expect(other).toContain('tabindex="-1"')
  })

  it('names_the_panel_only_for_the_shown_tab', () => {
    expect(html).toContain(`id="${tabDomId('a')}"`)
    expect(html).toContain(`aria-controls="${panelDomId('a')}"`)
    expect(html).not.toContain(`aria-controls="${panelDomId('b')}"`)
  })

  it('speaks_the_state_of_an_ended_tab_after_its_name', () => {
    expect(html).toContain(', ended with code 2')
  })

  it('names_every_icon_only_button', () => {
    expect(html).toContain('aria-label="Close Terminal 1"')
    expect(html).toContain('aria-label="New terminal"')
  })
})

describe('ended banner', () => {
  const render = (state: TabInfo['state']) =>
    renderToStaticMarkup(createElement(EndedBanner, { sessionId: 's1', tab: tab('a', 'Terminal 1', state), onRestarted: vi.fn() }))

  it('keeps_an_empty_status_region_mounted_while_the_shell_runs', () => {
    expect(render({ kind: 'running' })).toBe('<div role="status"></div>')
  })

  it('announces_an_ended_shell_through_the_status_region_without_a_nested_alert', () => {
    const html = render({ kind: 'ended', code: 1 })
    expect(html.startsWith('<div role="status">')).toBe(true)
    expect(html).toContain('Shell ended with code 1')
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('Restart shell')
  })

  it('announces_a_failed_start_with_its_reason', () => {
    const html = render({ kind: 'failed', message: 'pwsh was not found' })
    expect(html).toContain('The shell could not start')
    expect(html).toContain('pwsh was not found')
  })
})
