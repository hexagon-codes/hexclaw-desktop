import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import { createChatApprovalController } from '@/stores/chat-approval-controller'
import ToolApprovalCard from '../ToolApprovalCard.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})

const SESSION_ID = 'approval-profile-session'
const OWNER_ID = 'approval-profile-owner'

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function approvalRequest(toolName: string) {
  return {
    requestId: `approval-${toolName}`,
    sessionId: SESSION_ID,
    ownerId: OWNER_ID,
    invocationId: `invocation-${toolName}`,
    toolName,
    arguments: { fixture: true },
    argumentsDigest: 'a'.repeat(64),
    securityScopeDigest: 'b'.repeat(64),
    scopeSchemaVersion: 1,
    risk: toolName === 'browser' ? 'sensitive' : 'dangerous',
    reason: `approval required for ${toolName}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  } as const
}

function mountDesktopApprovalBoundary() {
  const pendingApprovals = ref<Record<string, ReturnType<typeof approvalRequest> & { receivedAt: number }>>({})
  const approvalCleanup = ref<(() => void) | null>(null)
  const responses = vi.fn()
  let receiveApproval: ((request: ReturnType<typeof approvalRequest>) => void) | undefined

  const controller = createChatApprovalController({
    pendingApprovals: pendingApprovals as any,
    approvalCleanup,
    ws: {
      onApprovalRequest(callback) {
        receiveApproval = callback as (request: ReturnType<typeof approvalRequest>) => void
        return () => { receiveApproval = undefined }
      },
    },
    approvalTransport: {
      sendApprovalResponse: responses,
    },
  })
  controller.initApprovalListener()

  const Host = defineComponent({
    setup() {
      const pending = computed(() => controller.getPendingApprovalForSession(SESSION_ID))
      return () => h('div', { 'data-testid': 'desktop-approval-host' }, [
        pending.value
          ? h(ToolApprovalCard, {
              requestId: pending.value.requestId,
              toolName: pending.value.toolName,
              arguments: pending.value.arguments,
              risk: pending.value.risk as 'safe' | 'sensitive' | 'dangerous',
              reason: pending.value.reason,
              deadlineAt: pending.value.deadlineAt,
              onRespond: controller.respondApproval,
            })
          : null,
      ])
    },
  })

  const wrapper = mount(Host, { global: { plugins: [testI18n()] } })
  return {
    wrapper,
    responses,
    receive(request: ReturnType<typeof approvalRequest>) {
      if (!receiveApproval) throw new Error('approval listener is not registered')
      receiveApproval(request)
    },
    dispose() {
      approvalCleanup.value?.()
      wrapper.unmount()
    },
  }
}

describe('REG-TOOL-APPROVAL-PROFILE-001/002 Desktop approval projection boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T06:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('full_access 的 Sidecar 零审批 wire 投影为零卡片、零 deadline、零 response', async () => {
    const boundary = mountDesktopApprovalBoundary()
    try {
      // 对应 Sidecar focused fixture 的 approval wire exact-set=0：Desktop 不自行造卡或响应。
      await nextTick()
      expect(boundary.wrapper.findAll('.hc-approval')).toHaveLength(0)
      expect(boundary.wrapper.findAll('.hc-approval__timer')).toHaveLength(0)
      expect(boundary.responses).not.toHaveBeenCalled()
    } finally {
      boundary.dispose()
    }
  })

  it('function_first 仅 browser/code_exec 零卡；shell wire 仍投影一张含 deadline 的卡', async () => {
    const basicBoundary = mountDesktopApprovalBoundary()
    try {
      await nextTick()
      expect(basicBoundary.wrapper.findAll('.hc-approval')).toHaveLength(0)
      expect(basicBoundary.wrapper.findAll('.hc-approval__timer')).toHaveLength(0)
      expect(basicBoundary.responses).not.toHaveBeenCalled()
    } finally {
      basicBoundary.dispose()
    }

    const shellBoundary = mountDesktopApprovalBoundary()
    try {
      shellBoundary.receive(approvalRequest('shell'))
      await nextTick()
      expect(shellBoundary.wrapper.findAll('.hc-approval')).toHaveLength(1)
      expect(shellBoundary.wrapper.get('.hc-approval__timer').text()).toBe('60s')
      expect(shellBoundary.responses).not.toHaveBeenCalled()
    } finally {
      shellBoundary.dispose()
    }
  })

  it('strict 的 browser/code_exec wire 均投影审批卡，未操作时 response 为零', async () => {
    for (const toolName of ['browser', 'code_exec']) {
      const boundary = mountDesktopApprovalBoundary()
      try {
        boundary.receive(approvalRequest(toolName))
        await flushPromises()
        expect(boundary.wrapper.findAll('.hc-approval')).toHaveLength(1)
        expect(boundary.wrapper.get('.hc-approval__timer').text()).toBe('60s')
        expect(boundary.responses).not.toHaveBeenCalled()
      } finally {
        boundary.dispose()
      }
    }
  })

  it('static deny 的 Sidecar 零审批 wire 不产生卡片或 response', async () => {
    const boundary = mountDesktopApprovalBoundary()
    try {
      await nextTick()
      expect(boundary.wrapper.findAll('.hc-approval')).toHaveLength(0)
      expect(boundary.wrapper.findAll('.hc-approval__timer')).toHaveLength(0)
      expect(boundary.responses).not.toHaveBeenCalled()
    } finally {
      boundary.dispose()
    }
  })
})
