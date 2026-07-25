/**
 * PromptsView destructive deletion regression:
 * every delete must pass through the shared ConfirmDialog and cancellation must preserve data.
 *
 * 砍薄版（§5）：原「记忆卡删除被伪装成停用」一案随记忆薄版移除而下线（记忆管理已迁至 MemoryView）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import PromptsView from '@/views/PromptsView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { getAllPrompts, deletePrompt, upsertPrompt } = vi.hoisted(() => ({
  getAllPrompts: vi.fn(),
  deletePrompt: vi.fn(),
  upsertPrompt: vi.fn(),
}))

vi.mock('@/api/prompts', () => ({
  getAllPrompts,
  deletePrompt,
  upsertPrompt,
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
describe('BUG: PromptsView destructive actions lack guards', () => {
  it('deleting a prompt must ask for confirmation, and cancel must abort the delete', async () => {
    vi.clearAllMocks()
    getAllPrompts.mockResolvedValue({ prompts: [onePrompt], total: 1 })
    deletePrompt.mockResolvedValue({ deleted: 'p1' })

    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.hc-icon-btn--danger').trigger('click')
    await flushPromises()

    const dialog = wrapper.findComponent(ConfirmDialog)
    expect(dialog.exists(), 'prompt deletion must open the shared confirmation dialog').toBe(true)
    expect(dialog.props('open')).toBe(true)
    dialog.vm.$emit('cancel')
    await flushPromises()

    expect(
      deletePrompt,
      'cancelling the confirmation must abort the delete — a misclick must not destroy data',
    ).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(false)
  })
})
