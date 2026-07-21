import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'
import ChatInput from '@/components/chat/ChatInput.vue'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import k12Zh from '../i18n/zh-CN'
import k12En from '../i18n/en'
import k12Ug from '../i18n/ug-CN'
import chatViewSource from '@/views/ChatView.vue?raw'

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    composer_chips: ['📚 自动识别学科', '💡 渐进提示', '📷 识题校验'],
  }),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function renderEnhancement(extra: Record<string, unknown> = {}) {
  return mount(K12ChatEnhancement, {
    props: {
      agentId: 'k12-tutor-ming',
      agentName: '小明的辅导助手',
      metadata: { 'k12.grade_term': '五年级上' },
      descriptor: K12_VIEW_DESCRIPTOR,
      ...extra,
    },
    global: {
      plugins: [createPinia(), i18n()],
      stubs: {
        K12RecordsView: {
          props: ['target', 'subject'],
          template:
            '<div data-testid="records-stub" :data-target="target" :data-subject="subject" />',
        },
        K12InsightPanel: true,
        RecognizeGuardPanel: true,
        K12BackupModal: true,
      },
    },
    attachTo: document.body,
  })
}

let wrappers: VueWrapper[] = []

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

beforeEach(() => {
  document.body.innerHTML = [
    '<div id="hc-chat-scenario-inline"></div>',
    '<div id="hc-chat-scenario-footer"></div>',
    '<div id="hc-chat-scenario-composer-top"></div>',
    '<div id="hc-chat-scenario-composer-actions"></div>',
    '<div id="hc-chat-scenario-sidepanel"></div>',
  ].join('')
})

afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers = []
  document.body.innerHTML = ''
})

describe('K12 composer 能力入口 · app.html 唯一权威', () => {
  it('新增 bridge/capabilities 文案在中英维三语保持同构', () => {
    const zhKeys = leafKeys({ bridge: k12Zh.bridge, capabilities: k12Zh.capabilities }).sort()
    expect(leafKeys({ bridge: k12En.bridge, capabilities: k12En.capabilities }).sort()).toEqual(
      zhKeys,
    )
    expect(leafKeys({ bridge: k12Ug.bridge, capabilities: k12Ug.capabilities }).sort()).toEqual(
      zhKeys,
    )
  })

  it('公共 ChatView 只接通结构化 action/command，不包含 K12 action 或文案', () => {
    expect(chatViewSource).toContain(':composer-action="scenarioComposerAction"')
    expect(chatViewSource).toContain('@composer-command="handleScenarioComposerCommand"')
    expect(chatViewSource).toContain('@preset-chip-action="handleScenarioComposerAction"')
    expect(chatViewSource).not.toContain('subject-capabilities')
    expect(chatViewSource).not.toContain('小学阶段 · 学科能力')
    expect(chatViewSource).not.toContain('看看还能做什么')
  })

  it('通用 composer 的 set-input 命令目标会写入文本并聚焦，不会自动发送', async () => {
    const sendHandler = vi.fn()
    const wrapper = mount(ChatInput, {
      props: { sendHandler },
      global: {
        plugins: [i18n()],
        stubs: { TemplatePopup: true, MentionPopup: true },
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    ;(wrapper.vm as unknown as { setInput: (text: string, focus?: boolean) => void }).setInput(
      '帮我写一条明天下午 3 点开家长会的通知',
      true,
    )
    await flushPromises()

    const input = wrapper.get<HTMLTextAreaElement>('[data-testid="chat-input"]')
    expect(input.element.value).toBe('帮我写一条明天下午 3 点开家长会的通知')
    expect(document.activeElement).toBe(input.element)
    expect(sendHandler).not.toHaveBeenCalled()
  })

  it('通用 ChatInput 对结构化 chip 只派发 action id，并保留独立关闭动作', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        presetChips: [
          { id: 'subject', label: '📚 自动识别学科', actionId: 'subject-capabilities' },
          { id: 'hint', label: '💡 渐进提示' },
        ],
      },
      global: {
        plugins: [i18n()],
        stubs: { TemplatePopup: true, MentionPopup: true },
      },
    })
    wrappers.push(wrapper)

    await wrapper.get('[data-testid="composer-preset-chip-action"]').trigger('click')
    expect(wrapper.emitted('preset-chip-action')).toEqual([['subject-capabilities']])

    await wrapper
      .get('[data-testid="composer-preset-chip"] .hc-composer__skill-remove')
      .trigger('click')
    expect(wrapper.emitted('preset-chip-action')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="composer-preset-chip"]')).toHaveLength(1)
  })

  it('首个后端 chip 被 K12 投影为可操作项；其余 chip 仍只是可关闭提示', async () => {
    const wrapper = renderEnhancement()
    wrappers.push(wrapper)
    await flushPromises()

    const events = wrapper.emitted('update:composerChips') ?? []
    expect(events[events.length - 1]?.[0]).toEqual([
      { id: 'k12-composer-chip-0', label: '📚 自动识别学科', actionId: 'subject-capabilities' },
      { id: 'k12-composer-chip-1', label: '💡 渐进提示' },
      { id: 'k12-composer-chip-2', label: '📷 识题校验' },
    ])
  })

  it('点击首个 chip 后完整呈现六科学科能力、三个原型示例入口和主动作', async () => {
    const wrapper = renderEnhancement({
      composerAction: { id: 'subject-capabilities', sequence: 1 },
    })
    wrappers.push(wrapper)
    await flushPromises()

    const dialog = document.querySelector<HTMLElement>('[data-testid="k12-capability-dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.textContent).toContain('小学阶段 · 学科能力')
    expect(dialog.textContent).toContain('一个孩子，一个长期辅导助手')
    expect(
      [...dialog.querySelectorAll('[data-testid="k12-subject-capability"]')].map(
        (item) => item.querySelector('b')?.textContent,
      ),
    ).toEqual(['数学', '语文', '英语', '科学', '信息科技', '美术'])
    expect(dialog.querySelectorAll('[data-testid="k12-subject-demo"]')).toHaveLength(3)
    expect(dialog.querySelector('[data-testid="k12-capability-primary"]')?.textContent).toBe(
      '拍一页作业试试',
    )
    ;(dialog.querySelector('[data-testid="k12-capability-primary"]') as HTMLElement).click()
    await flushPromises()
    const subjectCommands = wrapper.emitted('composerCommand') ?? []
    expect(subjectCommands[subjectCommands.length - 1]?.[0]).toEqual({ type: 'focus' })
    expect(document.querySelector('[data-testid="k12-capability-dialog"]')).toBeNull()
  })

  it('科学/信息科技进入原型示例弹窗；美术示例直接进入作品', async () => {
    const wrapper = renderEnhancement({
      composerAction: { id: 'subject-capabilities', sequence: 1 },
    })
    wrappers.push(wrapper)
    await flushPromises()

    const examples = document.querySelectorAll<HTMLElement>('[data-testid="k12-subject-demo"]')
    examples[0]!.click()
    await flushPromises()
    let dialog = document.querySelector<HTMLElement>('[data-testid="k12-capability-dialog"]')!
    expect(dialog.textContent).toContain('科学 · 小学能力示例')
    expect(dialog.textContent).toContain('小灯泡没有形成闭合回路')
    expect(dialog.textContent).toContain('图结构规则校验 · 不依赖模型主观猜测')
    ;(dialog.querySelector('[data-testid="k12-capability-primary"]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.get('[data-testid="records-stub"]').attributes('data-target')).toBe('mistakes')
    expect(wrapper.get('[data-testid="records-stub"]').attributes('data-subject')).toBe('科学')

    await wrapper.setProps({ composerAction: { id: 'subject-capabilities', sequence: 2 } })
    await flushPromises()
    document.querySelectorAll<HTMLElement>('[data-testid="k12-subject-demo"]')[1]!.click()
    await flushPromises()
    dialog = document.querySelector<HTMLElement>('[data-testid="k12-capability-dialog"]')!
    expect(dialog.textContent).toContain('信息科技 · 小学能力示例')
    expect(dialog.textContent).toContain('重复执行积木少循环 1 次')
    ;(dialog.querySelector('[data-testid="k12-capability-primary"]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.get('[data-testid="records-stub"]').attributes('data-subject')).toBe('信息科技')

    await wrapper.setProps({ composerAction: { id: 'subject-capabilities', sequence: 3 } })
    await flushPromises()
    document.querySelectorAll<HTMLElement>('[data-testid="k12-subject-demo"]')[2]!.click()
    await flushPromises()
    expect(document.querySelector('[data-testid="k12-capability-dialog"]')).toBeNull()
    expect(wrapper.get('[data-testid="records-stub"]').attributes('data-target')).toBe('works')
  })

  it('底部桥恢复原型链接；弹窗三类能力的主动作写入示例请求并聚焦', async () => {
    const wrapper = renderEnhancement()
    wrappers.push(wrapper)
    await flushPromises()

    const footer = document.getElementById('hc-chat-scenario-footer')!
    expect(footer.textContent).toContain(
      '我不只会辅导——写请假条、回复老师消息、记订正打卡提醒也能找我',
    )
    const link = footer.querySelector<HTMLElement>('[data-testid="k12-general-capabilities"]')!
    expect(link.textContent).toBe('看看还能做什么 ›')
    link.click()
    await flushPromises()

    const dialog = document.querySelector<HTMLElement>('[data-testid="k12-capability-dialog"]')!
    expect(dialog.textContent).toContain('这个 Agent 还能帮你做什么')
    expect(
      [...dialog.querySelectorAll('[data-testid="k12-general-capability"] b')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['家校沟通', '资料整理', '日程提醒'])
    expect(dialog.querySelector('[data-testid="k12-capability-primary"]')?.textContent).toBe(
      '填入示例请求',
    )
    ;(dialog.querySelector('[data-testid="k12-capability-primary"]') as HTMLElement).click()
    await flushPromises()
    const generalCommands = wrapper.emitted('composerCommand') ?? []
    expect(generalCommands[generalCommands.length - 1]?.[0]).toEqual({
      type: 'set-input',
      text: '帮我写一条明天下午 3 点开家长会的通知',
      focus: true,
    })
  })
})
