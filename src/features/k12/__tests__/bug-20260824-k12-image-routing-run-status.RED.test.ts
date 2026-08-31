import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UploadAsset: (...args: unknown[]) => h.upload(...args),
  k12CreateImageTask: (...args: unknown[]) => h.create(...args),
  k12GetImageTask: (...args: unknown[]) => h.get(...args),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function realHomeworkStage() {
  return {
    dispatch_id: 'dispatch-1',
    task_intent: 'completed_homework',
    status: 'routed',
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-1' },
    target_projection: {
      kind: 'homework',
      stage: 'assessing',
      confirmation_state: 'confirmed',
      anchor_state: 'located',
      structure_version: 1,
      recognition: { subject: '数学', questions: [] },
      problems: [],
      coverage: { state: 'incomplete', total: 1, processed: 0, skipped: 0 },
      final_artifact: null,
    },
    progress: { operation: 'homework', state: 'assessing' },
    version: 1,
    created_at: 1,
    updated_at: 2,
  }
}

describe('K12 图片意图判定等待态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('unknown intent 复用 AssistantRunStatus，真实任务阶段接管后不叠加', async () => {
    const upload = deferred<{ asset_id: string; size: number }>()
    h.upload.mockReturnValue(upload.promise)
    h.create.mockResolvedValue({ created: true, dispatch: realHomeworkStage() })
    h.get.mockReturnValue(new Promise(() => undefined))

    const wrapper = mount(RecognizeGuardPanel, {
      props: {
        agentId: 'mingming',
        grade: '五年级下',
        sessionId: 'session-1',
        requestId: 'message-1',
        initialImage: 'data:image/png;base64,T1JJR0lOQUw=',
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    const routingStatus = wrapper.find('[data-component="ImageTaskRunStatus"]')
    expect.soft(wrapper.findAll('[role="status"]')).toHaveLength(1)
    expect.soft(routingStatus.exists()).toBe(true)
    expect.soft(routingStatus.exists() ? routingStatus.text() : '').toBe('正在识别图片内容')
    expect
      .soft(routingStatus.exists() ? routingStatus.attributes('role') : undefined)
      .toBe('status')
    expect
      .soft(routingStatus.exists() ? routingStatus.attributes('aria-live') : undefined)
      .toBe('polite')
    expect
      .soft(routingStatus.exists() ? routingStatus.attributes('aria-atomic') : undefined)
      .toBe('true')
    expect
      .soft(wrapper.findAll('.hc-assistant-run-status__spinner[aria-hidden="true"]'))
      .toHaveLength(0)
    expect.soft(wrapper.findAll('.hc-typing-dots')).toHaveLength(1)
    expect.soft(wrapper.findAll('.hc-typing-dots__dot')).toHaveLength(3)

    upload.resolve({ asset_id: 'asset://mingming/homework.png', size: 3 })
    await flushPromises()

    expect(wrapper.findAll('[data-component="ImageTaskRunStatus"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="image-task-routing-progress"]')).toHaveLength(0)
    expect(wrapper.findAll('.hc-typing-dots')).toHaveLength(1)
    expect(wrapper.findAll('.hc-typing-dots__dot')).toHaveLength(3)
    expect(wrapper.findAll('.k12-task-progress')).toHaveLength(1)
    wrapper.unmount()
  })
})
