/**
 * BUG-20260621 (RED→GREEN 回归锁定): Prompt 库 二级 tab 在 0 件时仍渲染裸 "0"。
 *
 * 现象：能力 → Prompt 库，子 tab 显示「全部 0」「记忆 0」。空库时这个悬空的「0」
 *       像渲染残留/glitch，且与原型 app.html:758（Prompt 库 tab 为「全部」「记忆」无计数）不符。
 * 期望：计数为 0 时隐藏数字徽标（只显示「全部」「记忆」）；有数据时照常显示计数，
 *       保持与 Skills/MCP/知识库 一致（不波及那几个页面，本修复仅限 Prompt 库）。
 *
 * 关键：本测试用【真实的 UnderlineTabs】（不打桩），因为 bug 正是计数徽标的渲染。
 * 用例断言「正确行为」，在未修改代码上会 FAIL（当前渲染出两个 "0" 徽标）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import PromptsView from '@/views/PromptsView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getAllPrompts, getMemories, deletePrompt, deleteMemory, upsertPrompt, upsertMemory } =
  vi.hoisted(() => ({
    getAllPrompts: vi.fn(),
    getMemories: vi.fn(),
    deletePrompt: vi.fn(),
    deleteMemory: vi.fn(),
    upsertPrompt: vi.fn(),
    upsertMemory: vi.fn(),
  }))

vi.mock('@/api/prompts', () => ({
  getAllPrompts,
  getMemories,
  deletePrompt,
  deleteMemory,
  upsertPrompt,
  upsertMemory,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const HcSelectStub = { props: ['modelValue', 'options'], template: '<div class="hcselect-stub" />' }

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
      // 注意：不 stub UnderlineTabs —— 要验证真实计数徽标渲染
      stubs: {
        HcSelect: HcSelectStub,
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        teleport: true,
      },
    },
  })
}

const onePrompt = {
  id: 'p1',
  type: 'prompt' as const,
  title: '日报总结',
  body_md: '',
  args_json: '',
  tool_scope: '',
  model: '',
  category: '',
  enabled: true,
  updated_at: '',
}
const oneMemory = { id: 'm1', kind: 'fact' as const, content: '记住这条', updated_at: '' }

describe('BUG-20260621: Prompt 库 二级 tab 0 件时不应渲染数字徽标', () => {
  it('空库时「全部 / 记忆」不渲染任何计数徽标', async () => {
    getAllPrompts.mockResolvedValue({ prompts: [], total: 0 })
    getMemories.mockResolvedValue({ memories: [], total: 0 })

    const wrapper = mountView()
    await flushPromises()

    // 当前实现：每个 tab 都带 count:0 → 渲染出两个 .hc-utab__count("0") → 下面断言 FAIL。
    const badges = wrapper.findAll('.hc-utab__count')
    expect(
      badges.length,
      'empty Prompt 库 still renders dangling "0" count badges',
    ).toBe(0)

    // tab 文案应只剩「全部」「记忆」，不含悬空的「0」
    const tabTexts = wrapper.findAll('.hc-utab').map((b) => b.text())
    expect(tabTexts).toEqual(['全部', '记忆'])
  })

  it('有数据时计数照常显示（不能因为修复把非零计数也隐藏掉）', async () => {
    getAllPrompts.mockResolvedValue({ prompts: [onePrompt, { ...onePrompt, id: 'p2' }], total: 2 })
    getMemories.mockResolvedValue({ memories: [oneMemory], total: 1 })

    const wrapper = mountView()
    await flushPromises()

    const badges = wrapper.findAll('.hc-utab__count').map((b) => b.text())
    expect(badges).toEqual(['2', '1'])
  })
})
