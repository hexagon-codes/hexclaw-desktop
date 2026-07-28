import { describe, expect, it } from 'vitest'

import ollamaCardSource from '../OllamaCard.vue?raw'

function featuredModelsSource(): string {
  const start = ollamaCardSource.indexOf('const OLLAMA_FEATURED')
  const end = ollamaCardSource.indexOf(']', start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return ollamaCardSource.slice(start, end + 1)
}

describe('BUG-20260728-005 Ollama empty-search recommendations', () => {
  it('recommends qwen3-embedding:8b instead of deepseek-r1:32b', () => {
    const featured = featuredModelsSource()

    expect(featured.includes("'qwen3-embedding:8b'")).toBe(true)
    expect(featured.includes("'deepseek-r1:32b'")).toBe(false)
  })

  it('keeps deepseek-r1:32b in the searchable full catalog', () => {
    expect(
      ollamaCardSource.includes("{ name: 'deepseek-r1:32b', ram: 20 }"),
    ).toBe(true)
  })
})
