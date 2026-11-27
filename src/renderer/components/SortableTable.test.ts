// Issue #1848: a loading table shows skeleton rows in its column shape; the empty text is only for a finished load.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SortableTable, type SortableColumn } from './SortableTable'

interface Row {
  name: string
}

const columns: SortableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'count', header: 'Count', align: 'right', render: () => '1' }
]

const render = (props: { rows: Row[]; loading?: boolean }) =>
  renderToStaticMarkup(
    createElement(SortableTable<Row>, {
      caption: 'Things',
      columns,
      rows: props.rows,
      rowKey: (r) => r.name,
      sort: { key: 'name', dir: 'asc' },
      onSortChange: () => undefined,
      emptyText: 'No things',
      loading: props.loading
    })
  )

describe('SortableTable loading', () => {
  it('draws_three_skeleton_rows_across_every_column_instead_of_the_empty_text', () => {
    const html = render({ rows: [], loading: true })
    expect(html.match(/data-slot="table-skeleton-row"/g)).toHaveLength(3)
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(6)
    expect(html).not.toContain('No things')
  })

  it('hides_loaded_rows_while_loading_and_keeps_one_screen_reader_line', () => {
    const html = render({ rows: [{ name: 'alpha' }], loading: true })
    expect(html).not.toContain('alpha')
    expect(html.match(/Loading…/g)).toHaveLength(1)
  })

  it('marks_the_table_wrapper_busy_only_while_loading', () => {
    expect(render({ rows: [], loading: true })).toContain('aria-busy="true"')
    expect(render({ rows: [{ name: 'alpha' }] })).not.toContain('aria-busy')
  })

  it('renders_loaded_rows_with_no_skeleton_row_once_the_load_is_done', () => {
    const html = render({ rows: [{ name: 'alpha' }, { name: 'beta' }] })
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
    expect(html).not.toContain('table-skeleton-row')
  })

  it('shows_the_empty_text_once_loaded_with_no_rows', () => {
    const html = render({ rows: [] })
    expect(html).toContain('No things')
    expect(html).not.toContain('data-slot="skeleton"')
  })
})
