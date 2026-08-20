import { describe, expect, it } from 'vitest'

import ollamaCardSource from '../OllamaCard.vue?raw'

function sourceSection(startMarker: string, endMarker: string): string {
  const start = ollamaCardSource.indexOf(startMarker)
  const end = ollamaCardSource.indexOf(endMarker, start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return ollamaCardSource.slice(start, end)
}

describe('OllamaCard model catalog', () => {
  it('uses qwen3.8:27b in both the catalog and default recommendations', () => {
    const catalog = sourceSection('const OLLAMA_MODEL_CATALOG', '// 兼容层：纯名称列表')
    const featured = sourceSection('const OLLAMA_FEATURED', '// 本机总内存（GB）')

    expect(catalog).toContain("{ name: 'qwen3.8:27b', ram: 17 }")
    expect(catalog).not.toContain("qwen3.5:27b")
    expect(featured).toContain("'qwen3.8:27b'")
    expect(featured).not.toContain("qwen3.5:27b")
  })
})
