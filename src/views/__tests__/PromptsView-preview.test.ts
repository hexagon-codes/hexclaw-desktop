import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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

function prompt(body: string) {
  return {
    id: 'prompt-1',
    type: 'command' as const,
    title: '数学讲解',
    body_md: body,
    args_json: '',
    tool_scope: '',
    model: '',
    category: '',
    enabled: true,
    updated_at: '',
  }
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

async function openPreview(body: string) {
  getAllPrompts.mockResolvedValue({ prompts: [prompt(body)], total: 1 })
  const wrapper = mountView()
  await flushPromises()
  await wrapper
    .get('.hc-prompts__item-actions .hc-icon-btn:not(.hc-icon-btn--danger)')
    .trigger('click')
  await wrapper.findAll('.hc-body-tabs button')[1]!.trigger('click')
  await flushPromises()
  return wrapper
}

describe('PromptsView · shared Markdown preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('复用 MarkdownRenderer，同时保留占位高亮、KaTeX 与安全过滤', async () => {
    const wrapper = await openPreview(
      [
        '# 分数讲解',
        '',
        '参数：$ARGUMENTS / {{student.name}}',
        '',
        String.raw`公式：$\frac{3}{4}$`,
        '',
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[危险链接](javascript:alert(1))',
      ].join('\n'),
    )

    const preview = wrapper.get('.hc-body-prev')
    expect(preview.find('.markdown-body').exists()).toBe(true)
    expect(preview.get('h1').text()).toBe('分数讲解')
    expect(preview.findAll('.hc-arg').map((node) => node.text())).toEqual([
      '$ARGUMENTS',
      '{{student.name}}',
    ])
    expect(preview.find('.hc-math-inline .katex').exists()).toBe(true)
    expect(preview.find('script').exists()).toBe(false)
    expect(preview.find('[onerror]').exists()).toBe(false)
    expect(preview.find('a[href^="javascript:"]').exists()).toBe(false)
  })

  it('空正文保留本地化空态，不创建空 MarkdownRenderer', async () => {
    const wrapper = await openPreview('')
    const preview = wrapper.get('.hc-body-prev')

    expect(preview.get('.hc-prev-empty').text()).toBe('（空）')
    expect(preview.find('.markdown-body').exists()).toBe(false)
  })
})
