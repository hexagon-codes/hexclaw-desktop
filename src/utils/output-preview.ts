/**
 * Helpers for the collapsed run-output summary in task history (TasksView).
 */

/**
 * First-line summary of a run output, truncated to `max` Unicode code points.
 *
 * Truncation is code-point based ([...line]) instead of UTF-16 unit based
 * (line.slice) so surrogate pairs (emoji, rare CJK) are never split in half,
 * which would render as U+FFFD.
 */
export function outputPreview(text: string | null | undefined, max = 40): string {
  const line = (text ?? '').trim().split(/\r?\n/, 1)[0] ?? ''
  const points = [...line]
  return points.length > max ? points.slice(0, max).join('') + '…' : line
}

/**
 * Whether a run output is worth showing — whitespace-only stdout/stderr would
 * otherwise render an expand toggle with nothing behind it.
 */
export function hasOutput(text?: string | null): text is string {
  return typeof text === 'string' && text.trim().length > 0
}
