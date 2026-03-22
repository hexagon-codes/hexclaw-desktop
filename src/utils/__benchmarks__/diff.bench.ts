import { bench, describe } from 'vitest'
import { computeDiff } from '../diff'

function buildLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i}`)
}

describe('computeDiff benchmark', () => {
  const base1k = buildLines(1_000)
  const modified1k = base1k.map((line, index) => (index % 10 === 0 ? `${line} updated` : line))
  const base4k = buildLines(4_000)
  const modified4k = base4k.map((line, index) => (index % 20 === 0 ? `${line} updated` : line))

  bench('small equal payload', () => {
    computeDiff('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma')
  })

  bench('1k lines with sparse edits', () => {
    computeDiff(base1k.join('\n'), modified1k.join('\n'))
  })

  bench('4k lines fallback path', () => {
    computeDiff(base4k.join('\n'), modified4k.join('\n'))
  })
})
