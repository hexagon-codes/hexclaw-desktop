import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import { createChatApprovalController } from '@/stores/chat-approval-controller'
import ToolApprovalCard from '../ToolApprovalCard.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

interface MountOptions {
  requestId?: string
  toolName?: string
  arguments?: Record<string, unknown>
  risk?: 'safe' | 'sensitive' | 'dangerous'
  reason?: string
  timeout?: number
  deadlineAt?: string
}

function mountCard(overrides: MountOptions = {}) {
  return mount(ToolApprovalCard as any, {
    props: {
      requestId: overrides.requestId ?? 'req-123',
      toolName: overrides.toolName ?? 'file_write',
      arguments: overrides.arguments,
      risk: overrides.risk ?? 'sensitive',
      reason: overrides.reason ?? 'Writes to filesystem',
      deadlineAt: Object.prototype.hasOwnProperty.call(overrides, 'deadlineAt')
        ? overrides.deadlineAt
        : new Date(Date.now() + (overrides.timeout ?? 30) * 1000).toISOString(),
    },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

function mountApprovalEventBoundary(
  responder: (decision: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const pendingApprovals = ref<Record<string, Record<string, unknown>>>({})
  const controller = createChatApprovalController({
    pendingApprovals: pendingApprovals as any,
    ws: {},
    approvalTransport: {
      sendApprovalResponse: responder as any,
    },
  })
  controller.storePendingApproval({
    requestId: 'approval-request-1',
    sessionId: 'session-1',
    ownerId: 'desktop-user',
    invocationId: 'invocation-1',
    toolName: 'filesystem.write',
    argumentsDigest: 'a'.repeat(64),
    securityScopeDigest: 'b'.repeat(64),
    scopeSchemaVersion: 1,
    risk: 'dangerous',
    reason: 'Writes a generated file',
    deadlineAt,
  } as any)
  const errorHandler = vi.fn()
  const Host = defineComponent({
    setup() {
      return () => h(ToolApprovalCard, {
        requestId: 'approval-request-1',
        toolName: 'filesystem.write',
        risk: 'dangerous',
        reason: 'Writes a generated file',
        deadlineAt,
        onRespond: controller.respondApproval,
      })
    },
  })
  return {
    controller,
    errorHandler,
    pendingApprovals,
    wrapper: mount(Host, {
      global: {
        plugins: [createTestI18n()],
        config: { errorHandler },
      },
    }),
  }
}

describe('ToolApprovalCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the approved inline tool summary without extra approval metadata', () => {
    const wrapper = mountCard({
      toolName: 'filesystem.write_file',
      risk: 'dangerous',
      reason: 'Runs shell command',
      arguments: { path: '~/Desktop/report.md' },
    })

    expect(wrapper.get('.hc-approval__header').text().replace(/\s+/g, '')).toBe(
      '工具审批·filesystem.write_file30s',
    )
    expect(wrapper.get('.hc-approval__header code').text()).toBe('filesystem.write_file')
    expect(wrapper.get('.hc-approval__reason').text()).toBe('Runs shell command')
    expect(wrapper.find('.hc-approval__tool').exists()).toBe(false)
    expect(wrapper.find('.hc-approval__risk').exists()).toBe(false)
    expect(wrapper.find('.hc-approval__args').exists()).toBe(false)
  })

  it('does not auto-deny when the countdown reaches 0', () => {
    const wrapper = mountCard({ timeout: 3 })
    vi.advanceTimersByTime(3000)
    expect(wrapper.emitted('respond')).toBeUndefined()
  })

  it('timer interval cleaned up on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const wrapper = mountCard({ timeout: 60 })
    wrapper.unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('approve emits correct payload including remember flag', async () => {
    const wrapper = mountCard()
    // Check the remember checkbox
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    // Click approve
    const approveBtn = wrapper.find('.hc-approval__btn--approve')
    await approveBtn.trigger('click')
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['req-123', true, true])
  })

  it('deny emits correct payload with remember always false', async () => {
    const wrapper = mountCard()
    // Check remember, then deny — remember should still be false
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    const denyBtn = wrapper.find('.hc-approval__btn--deny')
    await denyBtn.trigger('click')
    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['req-123', false, false])
  })

  it('keeps the original controls disabled and busy while awaiting the backend acknowledgement', async () => {
    const wrapper = mountCard()
    const approveBtn = wrapper.find('.hc-approval__btn--approve')
    await approveBtn.trigger('click')

    const events = wrapper.emitted('respond') as unknown[][]
    expect(events).toHaveLength(1)
    expect(wrapper.get('.hc-approval').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.hc-approval__btn--approve').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.hc-approval__btn--deny').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.hc-approval__responded').exists()).toBe(false)

    await wrapper.get('.hc-approval__btn--approve').trigger('click')
    vi.advanceTimersByTime(60_000)
    expect(wrapper.emitted('respond')).toHaveLength(1)
  })

  it.each([
    {
      label: 'a mismatched acknowledgement',
      acknowledgement: (decision: Record<string, unknown>) => ({
        type: 'tool_approval_ack',
        request_id: 'other-request',
        decision_id: decision.decision_id,
        status: 'accepted',
      }),
    },
    {
      label: 'an unsupported acknowledgement status',
      acknowledgement: (decision: Record<string, unknown>) => ({
        type: 'tool_approval_ack',
        request_id: decision.request_id,
        decision_id: decision.decision_id,
        status: 'unknown',
      }),
    },
  ])('keeps $label out of the Vue error boundary and retains pending state', async ({ acknowledgement }) => {
    const responder = vi.fn((decision: Record<string, unknown>) =>
      Promise.resolve(acknowledgement(decision)),
    )
    const { controller, errorHandler, pendingApprovals, wrapper } = mountApprovalEventBoundary(responder)
    try {
      await wrapper.get('.hc-approval__btn--approve').trigger('click')
      await flushPromises()

      expect(errorHandler).not.toHaveBeenCalled()
      expect(Boolean(pendingApprovals.value['approval-request-1'])).toBe(true)

      await expect(controller.respondApproval('approval-request-1', true, false)).resolves.toBeUndefined()
      const first = responder.mock.calls[0]?.[0] as Record<string, unknown>
      const second = responder.mock.calls[1]?.[0] as Record<string, unknown>
      expect(second.decision_id).toBe(first.decision_id)
      expect(second.idempotency_key).toBe(first.idempotency_key)
    } finally {
      wrapper.unmount()
    }
  })

  it.each(['safe', 'sensitive', 'dangerous'] as const)(
    'does not render an unapproved risk badge for %s approvals',
    (risk) => {
      const wrapper = mountCard({ risk })
      expect(wrapper.find('.hc-approval__risk').exists()).toBe(false)
    },
  )

  it('does not expand approval arguments outside the approved summary', () => {
    const wrapper = mountCard({ arguments: { path: '/tmp/test.txt', content: 'hello' } })
    expect(wrapper.find('.hc-approval__args').exists()).toBe(false)
  })

  it('timer display projects the remaining seconds in the approved timer slot', async () => {
    const wrapper = mountCard({ timeout: 10 })
    const timer = wrapper.find('.hc-approval__timer')
    expect(timer.text()).toBe('10s')
    vi.advanceTimersByTime(4000)
    await wrapper.vm.$nextTick()
    expect(timer.text()).toBe('6s')
    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()
    expect(timer.text()).toBe('5s')
    expect(timer.classes()).toContain('hc-approval__timer')
  })
})

describe('ToolApprovalCard approved lifecycle RED contract', () => {
  it('does not synthesize a local deadline when the backend deadline is absent', () => {
    const wrapper = mountCard({ deadlineAt: undefined })

    expect(wrapper.get('.hc-approval__timer').text()).toBe('0s')
    expect(wrapper.get('.hc-approval__btn--approve').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.hc-approval__btn--deny').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
  })

  it('projects the server deadline without emitting a local denial', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T04:00:00.000Z'))
    let wrapper: ReturnType<typeof mountCard> | undefined
    try {
      wrapper = mountCard({
        requestId: 'approval-request-1',
        toolName: 'filesystem.write',
        risk: 'dangerous',
        reason: 'Writes a generated file',
        deadlineAt: '2026-07-29T04:00:05.000Z',
        timeout: 1,
      })

      await vi.advanceTimersByTimeAsync(6_000)

      expect(wrapper.emitted('respond')).toBeUndefined()
      expect(wrapper.get('.hc-approval__timer').text()).toBe('0s')
      expect(wrapper.get('.hc-approval__btn--approve').attributes('disabled')).toBeDefined()
      expect(wrapper.get('.hc-approval__btn--deny').attributes('disabled')).toBeDefined()
      expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()

      await wrapper.get('.hc-approval__btn--approve').trigger('click')
      await wrapper.get('.hc-approval__btn--deny').trigger('click')
      expect(wrapper.emitted('respond')).toBeUndefined()
    } finally {
      wrapper?.unmount()
      vi.useRealTimers()
    }
  })

  it('uses the exact approved remember checkbox copy', () => {
    const wrapper = mountCard({
      requestId: 'approval-request-1',
      toolName: 'filesystem.write',
      risk: 'dangerous',
      reason: 'Writes a generated file',
    })

    const checkbox = wrapper.get('input[type="checkbox"]')
    const labelCopy = checkbox.element.parentElement?.textContent?.replace(/\s+/g, '')
    expect(labelCopy).toBe('本会话内始终允许此工具')
  })

  it('keeps approval actions as non-submit buttons', () => {
    const wrapper = mountCard()

    expect(wrapper.get('.hc-approval__btn--deny').attributes('type')).toBe('button')
    expect(wrapper.get('.hc-approval__btn--approve').attributes('type')).toBe('button')
  })
})
