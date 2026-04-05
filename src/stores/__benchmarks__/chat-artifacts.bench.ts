import { bench, describe } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../chat'

function buildArtifactMessage(blocks: number): string {
  return Array.from({ length: blocks }, (_, index) => {
    const body = Array.from({ length: 8 }, (__, line) => `console.log("block-${index}-line-${line}")`)
      .join('\n')
    return `Section ${index}\n\`\`\`ts\n${body}\n\`\`\``
  }).join('\n\n')
}

describe('chat artifact extraction benchmark', () => {
  const message10 = buildArtifactMessage(10)
  const message100 = buildArtifactMessage(100)

  bench('extractArtifacts with 10 code blocks', () => {
    setActivePinia(createPinia())
    const store = useChatStore()
    store.extractArtifacts(message10, 'msg-10')
  })

  bench('extractArtifacts with 100 code blocks', () => {
    setActivePinia(createPinia())
    const store = useChatStore()
    store.extractArtifacts(message100, 'msg-100')
  })
})
