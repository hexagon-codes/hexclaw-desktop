/**
 * outputPreview / hasOutput — collapsed run-output summary helpers (TasksView).
 *
 * Review L1: `line.slice(0, max)` truncated by UTF-16 units and could split a
 * surrogate pair at the boundary, rendering U+FFFD. Truncation must be
 * code-point based.
 * Review L5: whitespace-only stdout/stderr rendered an empty expand toggle;
 * hasOutput() treats whitespace-only as absent.
 */
import { describe, it, expect } from 'vitest'
import { outputPreview, hasOutput } from '../output-preview'

describe('outputPreview', () => {
  it('keeps short single-line text intact', () => {
    expect(outputPreview('hello world')).toBe('hello world')
  })

  it('returns only the first line of multi-line output', () => {
    expect(outputPreview('first line\nsecond line')).toBe('first line')
    expect(outputPreview('first line\r\nsecond line')).toBe('first line')
  })

  it('does not split a surrogate pair when an emoji sits at the boundary', () => {
    // 39 ASCII chars + an emoji as the 40th code point; with a 40 cap the old
    // UTF-16 slice cut the emoji (2 units) in half producing a lone surrogate.
    const line = 'a'.repeat(39) + '😀' + 'tail beyond the limit'
    const preview = outputPreview(line, 40)
    expect(preview).toBe('a'.repeat(39) + '😀…')
    // No unpaired surrogate anywhere in the output.
    expect(preview.includes('�')).toBe(false)
    expect(() => encodeURIComponent(preview)).not.toThrow()
  })

  it('truncates by code points: 10 emoji with max 5 keeps 5 whole emoji', () => {
    const preview = outputPreview('😀'.repeat(10), 5)
    expect(preview).toBe('😀'.repeat(5) + '…')
  })

  it('keeps exactly 40 CJK chars without truncation', () => {
    const line = '汉'.repeat(40)
    expect(outputPreview(line, 40)).toBe(line)
  })

  it('truncates 41 CJK chars to 40 plus ellipsis', () => {
    const line = '汉'.repeat(41)
    expect(outputPreview(line, 40)).toBe('汉'.repeat(40) + '…')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(outputPreview('   \n\t  ')).toBe('')
    expect(outputPreview('')).toBe('')
  })

  it('tolerates null/undefined input', () => {
    expect(outputPreview(undefined)).toBe('')
    expect(outputPreview(null)).toBe('')
  })
})

describe('hasOutput', () => {
  it('rejects whitespace-only, empty, undefined and null', () => {
    expect(hasOutput('   \n  \t ')).toBe(false)
    expect(hasOutput('')).toBe(false)
    expect(hasOutput(undefined)).toBe(false)
    expect(hasOutput(null)).toBe(false)
  })

  it('accepts real content even when padded with whitespace', () => {
    expect(hasOutput('  result  ')).toBe(true)
    expect(hasOutput('x')).toBe(true)
  })
})
