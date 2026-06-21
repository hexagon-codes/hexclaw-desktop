/**
 * 统一命令面板（TemplatePopup）回归测试：Skill + Prompt 双源 + scope 过滤 + 选中分流。
 * 锁定 2026-06-21 会话框改造：skill/prompt 都支持按钮(scope) + 斜杠(all) 召回。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TemplatePopup from '@/components/chat/TemplatePopup.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getPrompts } = vi.hoisted(() => ({ getPrompts: vi.fn() }))
vi.mock('@/api/prompts', () => ({ getPrompts }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const SKILLS = [
  { name: 'translator', display_name: '翻译官', description: '多语种互译' },
  { name: 'coder', display_name: '编程搭子', description: '写代码' },
] as never[]

// 先 visible:false 挂载、再切 true —— 触发 watch(visible) 加载（与真实 app 的 false→true 一致）。
async function mountPalette(props: Record<string, unknown>) {
  const wrapper = mount(TemplatePopup, {
    props: {
      visible: false,
      query: '',
      position: { bottom: 0, left: 0 },
      skills: SKILLS,
      scope: 'all',
      ...props,
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { teleport: true },
    },
  })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  // 一个服务端 command 型 prompt（含 $ARGUMENTS）
  getPrompts.mockResolvedValue({
    prompts: [{ id: 'pr-1', title: '翻译', body_md: '翻译以下内容：$ARGUMENTS', category: 'command', type: 'command', updated_at: '' }],
    total: 1,
  })
})

describe('命令面板 TemplatePopup：scope + 双源 + 选中分流', () => {
  it("scope='skills' 只列 skill、不显示「新建模板」", async () => {
    const wrapper = await mountPalette({ scope: 'skills' })
    await flushPromises()
    const badges = wrapper.findAll('.tpl-popup__badge').map((b) => b.text())
    expect(badges.length).toBe(2)
    expect(badges.every((b) => b === 'Skill')).toBe(true)
    expect(wrapper.find('.tpl-popup__item--create').exists()).toBe(false)
  })

  it("scope='prompts' 只列 prompt + 显示「新建模板」", async () => {
    const wrapper = await mountPalette({ scope: 'prompts' })
    await flushPromises()
    const badges = wrapper.findAll('.tpl-popup__badge').map((b) => b.text())
    expect(badges).toEqual(['Prompt'])
    expect(wrapper.find('.tpl-popup__item--create').exists()).toBe(true)
  })

  it("scope='all'（斜杠召回）同时列 Skill + Prompt", async () => {
    const wrapper = await mountPalette({ scope: 'all' })
    await flushPromises()
    const badges = wrapper.findAll('.tpl-popup__badge').map((b) => b.text())
    expect(badges).toContain('Skill')
    expect(badges).toContain('Prompt')
  })

  it('选中 skill → emit {kind:skill, name}；选中 prompt → emit {kind:prompt, content}', async () => {
    const wrapper = await mountPalette({ scope: 'all' })
    await flushPromises()
    const items = wrapper.findAll('.tpl-popup__item')
    // skill 在前
    await items[0]!.trigger('click')
    const ev = wrapper.emitted('select')
    expect(ev).toBeTruthy()
    const first = ev![0]![0] as { kind: string; name?: string }
    expect(first.kind).toBe('skill')
    expect(first.name).toBe('translator')

    // 找到 prompt 项点击
    const promptItem = wrapper.findAll('.tpl-popup__item').find((i) =>
      i.find('.tpl-popup__badge').exists() && i.find('.tpl-popup__badge').text() === 'Prompt',
    )
    await promptItem!.trigger('click')
    const selectEvents = wrapper.emitted('select')!
    const last = selectEvents[selectEvents.length - 1]![0] as { kind: string; content?: string }
    expect(last.kind).toBe('prompt')
    expect(last.content).toContain('$ARGUMENTS')
  })

  it('「新建模板」点击 emit create', async () => {
    const wrapper = await mountPalette({ scope: 'prompts' })
    await flushPromises()
    await wrapper.find('.tpl-popup__item--create').trigger('click')
    expect(wrapper.emitted('create')).toBeTruthy()
  })
})
