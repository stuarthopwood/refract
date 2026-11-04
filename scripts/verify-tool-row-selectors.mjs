// The summary span of a CollapsedLine tool row, in both layouts (#1583). Collapsed, it is the row's own
// `min-w-0 flex-1` flex item. Wrapping, the label and summary share one `[data-summary-wrap]` host that
// carries `min-w-0 flex-1` instead, so a bare `span.min-w-0.flex-1` would hit that host (label text
// included) rather than the summary. Safe inside a single-quoted `querySelector('...')` literal.
export const TOOL_ROW_SUMMARY_SELECTOR =
  'span.min-w-0.flex-1:not([data-summary-wrap]), [data-summary-wrap] > span:not([data-slot="collapsed-line-label"])';
