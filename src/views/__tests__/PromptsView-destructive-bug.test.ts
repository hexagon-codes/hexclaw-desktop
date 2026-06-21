/**
 * BUG PROOF (RED): PromptsView 两处破坏性操作缺保护。
 *
 *  1) 删除 Prompt（垃圾桶按钮 → removePrompt）直接调 deletePrompt，无任何 window.confirm。
 *     仓库其它页（McpView confirm / AgentsView ConfirmDialog）都有删除确认，本页缺。
 *  2) 记忆卡的「停用」按钮（toggleMemoryEnabled）实际调用 deleteMemory —— 把不可逆删除
 *     伪装成可逆开关，用户点「停用」即永久丢数据。
 *
 * 两个用例都断言「正确行为」，当前会 FAIL —— 失败即证明 bug 存在。
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

// 用可点击的桩替换 UnderlineTabs，使我们能在测试里切换二级 tab（全部/记忆）。
const UnderlineTabsStub = {
  props: ['tabs', 'modelValue'],
  emits: ['update:model-value'],
  template:
    '<div class="tabs-stub"><button v-for="tt in tabs" :key="tt.key" :data-tab="tt.key" @click="$emit(\'update:model-value\', tt.key)" /></div>',
}
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
      stubs: {
        UnderlineTabs: UnderlineTabsStub,
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

describe('BUG: PromptsView destructive actions lack guards', () => {
  it('deleting a prompt must ask for confirmation, and cancel must abort the delete', async () => {
    getAllPrompts.mockResolvedValue({ prompts: [onePrompt], total: 1 })
    getMemories.mockResolvedValue({ memories: [], total: 0 })
    deletePrompt.mockResolvedValue({ deleted: 'p1' })
    // 用户点「取消」：正确实现应中止删除。
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.hc-icon-btn--danger').trigger('click')
    await flushPromises()

    // 当前实现：removePrompt 直接调 deletePrompt，无 confirm → 两条断言都 FAIL，证明缺确认保护。
    expect(confirmSpy, 'prompt deletion must prompt for confirmation').toHaveBeenCalled()
    expect(
      deletePrompt,
      'cancelling the confirmation must abort the delete — a misclick must not destroy data',
    ).not.toHaveBeenCalled()
  })

  it('a memory delete must be confirmed and must NOT be mislabeled as a reversible "停用"', async () => {
    getAllPrompts.mockResolvedValue({ prompts: [], total: 0 })
    getMemories.mockResolvedValue({ memories: [oneMemory], total: 1 })
    deleteMemory.mockResolvedValue({ deleted: 'm1' })
    // 用户点「取消」：正确实现应中止删除。
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const wrapper = mountView()
    await flushPromises()

    // 切到「记忆」子 tab
    await wrapper.find('[data-tab="memories"]').trigger('click')
    await flushPromises()

    const destructiveBtn = wrapper.find('.hc-mem-card__crow .hc-btn--ghost')
    expect(destructiveBtn.exists(), 'expected the memory card destructive button').toBe(true)

    // (a) 删除操作不得被伪装成可逆的「停用」——当前文案是「停用」→ FAIL。
    expect(
      destructiveBtn.text(),
      'a button that deletes a memory must be labeled 删除, not the misleading 停用',
    ).not.toContain('停用')

    await destructiveBtn.trigger('click')
    await flushPromises()

    // (b) 当前实现：「停用」直接 deleteMemory、无 confirm → 两条断言都 FAIL。
    expect(confirmSpy, 'deleting a memory must prompt for confirmation').toHaveBeenCalled()
    expect(
      deleteMemory,
      'cancelling the confirmation must abort the delete — irreversible data loss must not happen on a misclick',
    ).not.toHaveBeenCalled()
  })
})
