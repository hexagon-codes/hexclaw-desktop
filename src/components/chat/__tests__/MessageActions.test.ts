import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MessageActions from '../MessageActions.vue'
import messageActionsSource from '../MessageActions.vue?raw'

const { speakMock, stopMock, toastError, voiceError, isSpeaking } = vi.hoisted(() => ({
  speakMock: vi.fn(),
  stopMock: vi.fn(),
  toastError: vi.fn(),
  voiceError: { value: null as string | null },
  isSpeaking: { __v_isRef: true, value: false },
}))

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({
    isSpeaking,
    error: voiceError,
    speak: speakMock,
    stopSpeaking: stopMock,
  }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function mountMessageActions(feedback: 'like' | 'dislike' | null) {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })

  return mount(MessageActions, {
    props: {
      role: 'assistant',
      content: 'test',
      feedback,
    },
    global: {
      plugins: [i18n],
    },
  })
}

function mountTaskStageActions() {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })

  return mount(MessageActions, {
    props: {
      role: 'assistant',
      content: '图片任务',
      retryMode: 'task-stage',
      showFork: false,
    },
    global: { plugins: [i18n] },
  })
}

function mountUserMessageActions() {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })

  return mount(MessageActions, {
    props: { role: 'user', content: 'hi' },
    global: { plugins: [i18n] },
  })
}

describe('MessageActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceError.value = null
    isSpeaking.value = false
  })

  it('replays persisted like state', () => {
    const wrapper = mountMessageActions('like')
    const buttons = wrapper.findAll('button')
    expect(buttons[0]?.classes()).toContain('hc-msg-actions__btn--active')
    expect(buttons[1]?.classes()).not.toContain('hc-msg-actions__btn--active-bad')
  })

  it('replays persisted dislike state', () => {
    const wrapper = mountMessageActions('dislike')
    const buttons = wrapper.findAll('button')
    expect(buttons[1]?.classes()).toContain('hc-msg-actions__btn--active-bad')
  })

  it('keeps the approved assistant action exact-set and order', () => {
    const wrapper = mountMessageActions(null)

    expect(wrapper.findAll('button').map((button) => button.attributes('aria-label'))).toEqual([
      zhCN.chat.liked,
      zhCN.chat.disliked,
      zhCN.common.copy,
      zhCN.chat.regenerate,
      zhCN.chat.speakMessage,
      zhCN.chat.createBranch,
    ])
  })

  it('places task-stage retry before speak with its own semantic label and shared icons', async () => {
    const wrapper = mountTaskStageActions()

    expect(wrapper.findAll('button').map((button) => button.attributes('aria-label'))).toEqual([
      zhCN.chat.liked,
      zhCN.chat.disliked,
      zhCN.common.copy,
      zhCN.chat.retryCurrentStage,
      zhCN.chat.speakMessage,
    ])
    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(false)
    /* expect(
      wrapper
        .findAll('button')
        .map((button) => button.findAll('path').map((path) => path.attributes('d'))),
    ).toEqual([
      ['M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z', 'M7 10v12'],
      ['M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z', 'M17 14V2'],
      ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
      ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
      ['M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z', 'M16 9a5 5 0 0 1 0 6', 'M19.364 18.364a9 9 0 0 0 0-12.728'],
    ]) */
    expect(messageActionsSource).toMatch(/<ThumbsUp :size="14" \/>/)
    expect(messageActionsSource).toMatch(/<ThumbsDown :size="14" \/>/)
    expect(messageActionsSource).toMatch(/<Copy v-else :size="14" \/>/)
    expect(messageActionsSource).toMatch(/<RotateCcw :size="14" \/>/)
    expect(messageActionsSource).toMatch(/<Volume2 v-else :size="14" \/>/)
    const retry = wrapper.get('[data-testid="message-task-stage-retry"]')
    expect(retry.attributes('title')).toBe(zhCN.chat.retryCurrentStage)
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('labels the shared toolbar and keeps prototype button geometry interactions', () => {
    const wrapper = mountMessageActions(null)

    expect(wrapper.attributes('aria-label')).toBe(zhCN.chat.messageActions)
    expect(wrapper.get('.hc-msg-actions__divider').attributes('aria-hidden')).toBe('true')
    expect(messageActionsSource).toMatch(/\.hc-msg-actions__btn\s*\{[\s\S]*?border-radius:\s*7px;/)
    expect(messageActionsSource).toMatch(
      /\.hc-msg-actions__btn:active\s*\{[\s\S]*?transform:\s*scale\(0\.9\);/,
    )
    expect(messageActionsSource).toMatch(
      /\.hc-msg-actions__btn svg\s*\{[\s\S]*?fill:\s*none;[\s\S]*?stroke:\s*currentColor;[\s\S]*?stroke-linecap:\s*round;[\s\S]*?stroke-linejoin:\s*round;/,
    )
  })

  // Bug 复现(2026-06-25): 喇叭点了没反应 —— speak() 把后端错误(如 TTS 未配置)静默吞掉、零反馈。
  it('surfaces TTS failure via toast when speak fails', async () => {
    speakMock.mockImplementation(async () => {
      voiceError.value = 'TTS 服务未配置'
    })
    const wrapper = mountMessageActions(null)
    await wrapper.get(`[aria-label="${zhCN.chat.speakMessage}"]`).trigger('click')
    await flushPromises()
    expect(speakMock).toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('does not toast when speak succeeds', async () => {
    speakMock.mockImplementation(async () => {
      /* success: no error set */
    })
    const wrapper = mountMessageActions(null)
    await wrapper.get(`[aria-label="${zhCN.chat.speakMessage}"]`).trigger('click')
    await flushPromises()
    expect(speakMock).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  // 重新生成（retry）按钮：对齐 ChatGPT/Claude/豆包/DeepSeek 的「重新生成」。
  it('renders the regenerate (retry) button for assistant messages and emits retry', async () => {
    const wrapper = mountMessageActions(null)
    const retryBtn = wrapper.get('[data-testid="message-regenerate"]')
    expect(retryBtn.attributes('title')).toBe(zhCN.chat.regenerate)
    await wrapper.setProps({ retryDisabled: true })
    expect(retryBtn.attributes('disabled')).toBeDefined()
    await retryBtn.trigger('click')
    expect(wrapper.emitted('retry')).toBeUndefined()
    await wrapper.setProps({ retryDisabled: false })
    await retryBtn.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('copy button degrades gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountMessageActions(null)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    const copyButton = wrapper.findAll('button')[2]
    await expect(copyButton?.trigger('click')).resolves.toBeUndefined()
    expect(wrapper.emitted('copy')).toHaveLength(1)
  })

  it('exposes role-specific presentation hooks for inline assistant actions and unchanged user actions', () => {
    expect(mountMessageActions(null).classes()).toContain('hc-msg-actions--assistant')
    expect(mountUserMessageActions().classes()).toContain('hc-msg-actions--user')
  })

  it('uses the prototype 10px radius for the floating user action toolbar', () => {
    expect(messageActionsSource).toMatch(
      /\.hc-msg-actions--user\s*\{[\s\S]*?border-radius:\s*10px;/,
    )
  })

  it('renders fork as a first-level assistant button and never exposes delete or More menu', async () => {
    const wrapper = mountMessageActions(null)
    const forkBtn = wrapper.get('[data-testid="message-fork"]')
    expect(forkBtn.attributes('title')).toBe('创建分支')
    expect(forkBtn.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="message-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-delete"]').exists()).toBe(false)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await forkBtn.trigger('click')
    expect(wrapper.emitted('fork')).toHaveLength(1)
  })

  it('keeps the user actions at copy + edit only, without fork, delete or More menu', () => {
    const wrapper = mountUserMessageActions()
    expect(wrapper.find('[data-testid="message-fork"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-delete"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(2)
  })

  it('drops the More menu machinery from the source', () => {
    expect(messageActionsSource).toContain('import {\n  Copy,')
    expect(messageActionsSource).toContain('GitBranch')
    expect(messageActionsSource).not.toContain('Trash2')
    expect(messageActionsSource).not.toContain('MoreHorizontal')
    expect(messageActionsSource).not.toContain('message-more')
    expect(messageActionsSource).not.toContain('message-delete')
    expect(messageActionsSource).not.toContain('hc-msg-actions__more-menu')
  })
})
