import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import PromptsView from '@/views/PromptsView.vue'

const { getAllPrompts, replaceRoute } = vi.hoisted(() => ({
  getAllPrompts: vi.fn(),
  replaceRoute: vi.fn(),
}))

vi.mock('@/api/prompts', () => ({
  getAllPrompts,
  deletePrompt: vi.fn(),
  upsertPrompt: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/integration/prompts', query: {} }),
  useRouter: () => ({ replace: replaceRoute }),
}))

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})

const HcSelectStub = {
  props: ['modelValue', 'options'],
  template: '<div class="hcselect-stub" />',
}

function mountView() {
  return mount(PromptsView, {
    global: {
      plugins: [
        createPinia(),
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': zhCN, zh: zhCN },
        }),
      ],
      stubs: {
        HcSelect: HcSelectStub,
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ArtifactRenderer: { template: '<div />' },
        teleport: true,
      },
    },
  })
}

async function openNewPrompt() {
  getAllPrompts.mockResolvedValue({ prompts: [], total: 0 })
  const wrapper = mountView()
  await flushPromises()
  const exposed = wrapper.vm as unknown as { newPrompt: () => void }
  exposed.newPrompt()
  await wrapper.vm.$nextTick()
  return { wrapper, dialog: wrapper.get('[data-testid="prompt-editor-dialog"]') }
}

type PromptQuery = Pick<DOMWrapper<Element>, 'findAll'>
type PromptField = ReturnType<DOMWrapper<Element>['findAll']>[number]

function fieldByLabel(dialog: PromptQuery, label: string): PromptField | undefined {
  return dialog
    .findAll('.hc-field')
    .find((field: PromptField) => field.find('label').text().includes(label))
}

describe('PromptsView · BUG-20260723-003', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('打开新建 Prompt 时默认 command，并显示可见的 /translate 输入', async () => {
    const { dialog } = await openNewPrompt()

    const commandInput = dialog
      .findAll('input')
      .find((input: PromptField) => (input.element as HTMLInputElement).value === '/translate')

    expect(commandInput).toBeDefined()
    expect(commandInput?.isVisible()).toBe(true)
  })

  it('类型使用 command/prompt 分段控件而非 HcSelect', async () => {
    const { dialog } = await openNewPrompt()
    const typeField = fieldByLabel(dialog, '类型')!

    expect(typeField.find('.hcselect-stub').exists()).toBe(false)
    expect(typeField.findAll('button').map((button: PromptField) => button.text().trim())).toEqual(
      expect.arrayContaining(['命令 /', '片段']),
    )
  })

  it('工具范围同时提供预设按钮和自定义字段', async () => {
    const { dialog } = await openNewPrompt()
    const scopeField = fieldByLabel(dialog, '工具范围')!

    expect(scopeField.findAll('button').length).toBeGreaterThan(0)
    expect(scopeField.find('input').exists()).toBe(true)
  })

  it('新建 Prompt 编辑器不存在启用开关', async () => {
    const { dialog } = await openNewPrompt()

    expect(dialog.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('新建 Prompt 主按钮文案为保存', async () => {
    const { dialog } = await openNewPrompt()

    expect(dialog.get('button.hc-btn-primary').text().trim()).toBe('保存')
  })

  it('新建 Prompt 原型保存按钮默认可用', async () => {
    const { dialog } = await openNewPrompt()
    expect((dialog.get('button.hc-btn-primary').element as HTMLButtonElement).disabled).toBe(false)
  })
})
