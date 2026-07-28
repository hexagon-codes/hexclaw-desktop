import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/components/settings/OllamaCard.vue'), 'utf8')

describe('BUG-20260728-013/014 Ollama 删除必须复用全局危险操作合同', () => {
  it('行内删除只登记目标并消费共享 ConfirmDialog，不得直接调用删除流程或覆盖全局冷却', () => {
    expect(
      /import\s+ConfirmDialog\s+from\s+['"]@\/components\/common\/ConfirmDialog\.vue['"]/.test(source),
      'OllamaCard must import the shared ConfirmDialog',
    ).toBe(true)
    expect(source.includes('<ConfirmDialog'), 'OllamaCard must render the shared ConfirmDialog').toBe(true)
    expect(/confirmation-key/.test(source), 'OllamaCard must isolate the full model tag').toBe(true)
    expect(
      source.includes('@click="handleDelete(m.name)"'),
      'the row action must not invoke deletion directly',
    ).toBe(false)
    expect(/confirm-delay-ms/.test(source), 'the page must not override the global cooldown').toBe(false)
  })

  it('删除失败通过共享 Toast 使用现有文案反馈，不得只写未渲染的私有错误 ref', () => {
    expect(
      /import\s+\{\s*useToast\s*\}\s+from\s+['"]@\/composables\/useToast['"]/.test(source),
      'OllamaCard must import the shared toast composable',
    ).toBe(true)
    expect(/toast\.error\(/.test(source), 'delete failure must call the shared error toast').toBe(true)
    expect(
      source.includes('settings.ollama.deleteFailed'),
      'delete failure must reuse the existing localized copy',
    ).toBe(true)
    expect(
      /const\s+deleteError\s*=\s*ref/.test(source),
      'an unrendered page-private error ref is not user-visible feedback',
    ).toBe(false)
  })
})
