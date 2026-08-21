import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  applyPolicy: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  unsupported: vi.fn(),
  getStatus: vi.fn(),
  pullModel: vi.fn(),
}))

vi.mock('@/api/knowledge-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getKnowledgeEmbeddingPolicy: (...args: unknown[]) => mocks.getPolicy(...args),
  applyKnowledgeEmbeddingPolicy: (...args: unknown[]) => mocks.applyPolicy(...args),
  getKnowledgeJob: (...args: unknown[]) => mocks.getJob(...args),
  cancelKnowledgeJob: (...args: unknown[]) => mocks.cancelJob(...args),
  isKnowledgeEmbeddingPolicyUnsupported: (...args: unknown[]) => mocks.unsupported(...args),
}))

vi.mock('@/api/knowledge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getKnowledgeEmbeddingStatus: (...args: unknown[]) => mocks.getStatus(...args),
}))

vi.mock('@/api/ollama', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pullOllamaModel: (...args: unknown[]) => mocks.pullModel(...args),
}))

import SemanticIndexCard from '../SemanticIndexCard.vue'

const readyProjection = {
  policy_version: 7,
  selection: { kind: 'auto' as const },
  indexing_activity: {
    state: 'idle' as const,
    processing_documents: 0,
    chunks_done: 225,
    chunks_total: 225,
  },
  catalog_version: 3,
  recommendation: {
    profile_id: 'cloud-sf',
    reason_code: 'large_document',
    reason_text: '大文件优先云端批处理',
  },
  available_profiles: [
    {
      profile_id: 'cloud-sf',
      model_name: 'BAAI/bge-m3',
      provider_id: 'siliconflow',
      provider_name: 'SiliconFlow',
      location: 'cloud' as const,
      capability: 'embedding' as const,
      dimension: 1024,
      availability: 'connected' as const,
      display_order: 10,
    },
    {
      profile_id: 'local-nomic',
      model_name: 'nomic-embed-text',
      provider_id: 'ollama',
      provider_name: 'Ollama',
      location: 'local' as const,
      capability: 'embedding' as const,
      dimension: 768,
      availability: 'installed' as const,
      display_order: 20,
    },
    {
      profile_id: 'local-mxbai',
      model_name: 'mxbai-embed-large',
      provider_id: 'ollama',
      provider_name: 'Ollama',
      location: 'local' as const,
      capability: 'embedding' as const,
      dimension: 1024,
      availability: 'downloadable' as const,
      display_order: 30,
    },
  ],
  active_revision: {
    revision_id: 'rev-a',
    state: 'ready' as const,
    profile: {
      profile_id: 'cloud-sf',
      model_name: 'BAAI/bge-m3',
      provider_id: 'siliconflow',
      provider_name: 'SiliconFlow',
      location: 'cloud' as const,
      capability: 'embedding' as const,
      dimension: 1024,
      availability: 'connected' as const,
      display_order: 10,
    },
    chunks_done: 225,
    chunks_total: 225,
  },
  desired_revision: null,
}

function failedExplicitDesiredProjection() {
  return {
    ...structuredClone(readyProjection),
    policy_version: 8,
    selection: { kind: 'profile' as const, profile_id: 'local-nomic' },
    indexing_activity: {
      state: 'failed' as const,
      processing_documents: 0,
      chunks_done: 135,
      chunks_total: 225,
    },
    desired_revision: {
      revision_id: 'rev-b',
      job_id: 'job-b',
      state: 'failed' as const,
      profile: structuredClone(readyProjection.available_profiles[1]),
      chunks_done: 135,
      chunks_total: 225,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function i18n(locale = 'zh-CN') {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: locale === 'zh-CN' ? 'zh-CN' : false,
    messages: { 'zh-CN': zhCN, zh: zhCN, en, 'ug-CN': ugCN },
  })
}

const mountedWrappers: ReturnType<typeof mount>[] = []

function mountCard(locale = 'zh-CN') {
  const wrapper = mount(SemanticIndexCard, {
    global: { plugins: [i18n(locale)] },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

function expectNativeRetryButton(wrapper: ReturnType<typeof mount>) {
  const retry = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-retry-rebuild"]')
  expect(retry.element.tagName).toBe('BUTTON')
  expect(retry.attributes('type')).toBe('button')
  expect(retry.text()).toBe('重试')
}

describe('SemanticIndexCard', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetAllMocks()
    mocks.getPolicy.mockResolvedValue(structuredClone(readyProjection))
    mocks.applyPolicy.mockResolvedValue({
      policy_version: 8,
      selection: { kind: 'profile', profile_id: 'local-nomic' },
      active_revision_id: 'rev-a',
      desired_revision_id: 'rev-b',
      job_id: 'job-b',
    })
    mocks.cancelJob.mockResolvedValue({
      job_id: 'job-b',
      state: 'cancelled',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 135,
      chunks_total: 225,
    })
    mocks.unsupported.mockReturnValue(false)
    mocks.getJob.mockResolvedValue({
      job_id: 'job-b',
      state: 'succeeded',
      stage: 'publishing',
      pages_done: null,
      pages_total: null,
      chunks_done: 225,
      chunks_total: 225,
    })
    mocks.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      local: true,
      ready: true,
      pulling: false,
    })
  })

  afterEach(async () => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    await flushPromises()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('is collapsed by default and keeps selection, actual model and real state in the summary', async () => {
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-semantic-index-card"]').text()).toContain('语义索引')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('自动')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('SiliconFlow')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).not.toContain(
      'BAAI/bge-m3',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')
    expect(wrapper.find('[data-testid="kb-semantic-index-layers-icon"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('语义索引（高级）')
    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="kb-semantic-index-body"]').isVisible()).toBe(false)
    expect(
      wrapper.get('[data-testid="kb-semantic-index-header"]').attributes('aria-controls'),
    ).toBe('kb-semantic-index-body')
    expect(
      wrapper.get('[data-testid="kb-semantic-index-header"]').attributes('aria-expanded'),
    ).toBe('false')
  })

  it('expands to a single model selector with inline provider boundary and no dialog', async () => {
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="kb-index-model-trigger"]')).toHaveLength(1)
    const notice = document.body.querySelector('[data-testid="kb-index-provider-notice"]')
    expect(notice?.textContent).toContain(
      '云端模型由你配置的第三方 Provider 提供。HexClaw 仅负责连接与调用；索引文本和查询文本会发送至该服务商，计费与数据处理规则以其为准。',
    )
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(
      document.body.querySelector('[data-testid="kb-index-provider-docs"]')?.getAttribute('href'),
    ).toBe('https://hexclaw.net/zh/third-party-ai-services')
    expect(document.body.querySelector('[data-testid="kb-index-provider-docs"]')?.textContent).toBe(
      '查看第三方 AI 服务说明 ↗',
    )
    expect(document.body.textContent).not.toContain('本地模型不会上传')
    expect(document.body.textContent).not.toContain('聊天模型')
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-label')).toBe(
      '索引模型: 自动（推荐）',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      '系统会根据当前可用能力选择索引模型。当前使用 SiliconFlow · BAAI/bge-m3；语义增强 225/225 个切片。',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '实际使用 SiliconFlow · BAAI/bge-m3',
    )
  })

  it('submits only profile intent plus expected version, then refreshes the projection', async () => {
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()

    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    const local = options.find((option) => option.textContent?.includes('nomic-embed-text'))
    expect(local).toBeTruthy()
    local?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 7, {
      kind: 'profile',
      profile_id: 'local-nomic',
    })
    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    const request = mocks.applyPolicy.mock.calls[0]?.[2]
    expect(request).not.toHaveProperty('location')
    expect(request).not.toHaveProperty('provider_id')
    expect(request).not.toHaveProperty('model_name')
  })

  it('moves focus to the semantic-index heading when a selection starts a rebuild', async () => {
    const rebuilding = {
      ...structuredClone(readyProjection),
      policy_version: 8,
      selection: { kind: 'profile' as const, profile_id: 'local-nomic' },
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 0,
        chunks_total: 225,
      },
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 0,
        chunks_total: 225,
      },
    }
    mocks.getPolicy
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(rebuilding)

    const wrapper = mountCard()
    await flushPromises()
    const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
    await header.trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()

    const local = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('nomic-embed-text'),
    )
    local?.click()
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      'true',
    )
    expect(document.activeElement).toBe(header.element)
  })

  it('moves focus to the semantic-index heading when polling externally locks the selector', async () => {
    vi.useFakeTimers()
    const enhancing = {
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    const rebuilding = {
      ...enhancing,
      policy_version: 8,
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    mocks.getPolicy.mockResolvedValueOnce(enhancing).mockResolvedValueOnce(rebuilding)

    const wrapper = mountCard()
    await flushPromises()
    const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
    await header.trigger('click')
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="kb-index-model-trigger"]')
    trigger.element.focus()
    await trigger.trigger('click')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    await trigger.trigger('keydown', { key: 'Tab' })
    const docsLink = document.body.querySelector<HTMLAnchorElement>(
      '[data-testid="kb-index-provider-docs"]',
    )
    expect(document.activeElement).toBe(docsLink)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(trigger.attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(header.element)
  })

  it('announces dynamic policy state through one live region', async () => {
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

    const liveRegions = wrapper.findAll('[aria-live], [role="status"]')
    expect(liveRegions).toHaveLength(1)
    expect(liveRegions[0]?.text()).toContain('已就绪')
    expect(liveRegions[0]?.text()).toContain('文本 + 语义已就绪')
  })

  it('announces an apply failure only through the primary live region', async () => {
    mocks.applyPolicy.mockRejectedValueOnce(new Error('apply failed'))
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()

    const local = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('nomic-embed-text'),
    )
    local?.click()
    await flushPromises()

    const inlineError = wrapper.get('.kb-index-card__inline-error')
    expect(inlineError.text()).toContain('apply failed')
    expect(inlineError.attributes('role')).toBeUndefined()
    const liveRegions = wrapper.findAll('[aria-live], [role="status"], [role="alert"]')
    expect(liveRegions).toHaveLength(1)
    expect(liveRegions[0]?.text()).toContain('apply failed')
  })

  it('keeps ordinary document enhancement separate from desired revision and collapsed', async () => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building',
        processing_documents: 1,
        chunks_done: 135,
        chunks_total: 225,
      },
    })
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="kb-semantic-index-body"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('1 项处理中')

    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      '当前使用 SiliconFlow · BAAI/bge-m3；语义增强 135/225 个切片。',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '当前索引可用 · 1 个文档增强中',
    )
  })

  it('locks selection and shows persistent progress during a staged rebuild', async () => {
    const rebuilding = {
      ...structuredClone(readyProjection),
      selection: { kind: 'profile' as const, profile_id: 'local-nomic' },
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 135,
        chunks_total: 225,
      },
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 135,
        chunks_total: 225,
      },
    }
    mocks.getPolicy.mockResolvedValueOnce(rebuilding)
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="kb-semantic-index-body"]').isVisible()).toBe(false)
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '当前索引可用 · 新索引 135/225',
    )

    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(true)
  })

  it.each(['pending', 'building', 'retry_wait', 'failed'] as const)(
    'confirms cancellation of a %s desired rebuild and restores header focus on either choice',
    async (state) => {
      const desired = {
        ...structuredClone(readyProjection),
        policy_version: 8,
        indexing_activity: {
          state: state === 'failed' ? ('failed' as const) : ('building' as const),
          processing_documents: state === 'failed' ? 0 : 1,
          chunks_done: 135,
          chunks_total: 225,
        },
        desired_revision: {
          revision_id: 'rev-b',
          job_id: 'job-b',
          state,
          profile: readyProjection.available_profiles[1],
          chunks_done: 135,
          chunks_total: 225,
        },
      }
      mocks.getPolicy
        .mockResolvedValueOnce(desired)
        .mockResolvedValueOnce({ ...structuredClone(readyProjection), policy_version: 9 })

      const wrapper = mountCard()
      await flushPromises()
      if (!wrapper.get('[data-testid="kb-semantic-index-body"]').isVisible()) {
        await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
      }
      const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
      await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
      await flushPromises()

      let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
      expect(dialog?.textContent).toContain('取消本次重建？')
      expect(dialog?.textContent).toContain(
        '当前索引不会受影响。已完成的新索引批次不会参与查询；文本检索与当前语义索引继续可用。',
      )
      expect(mocks.cancelJob).not.toHaveBeenCalled()

      const continueButton = [
        ...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []),
      ].find((button) => button.textContent?.includes('继续后台重建'))
      expect(continueButton).toBeTruthy()
      continueButton?.click()
      await flushPromises()

      expect(mocks.cancelJob).not.toHaveBeenCalled()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(header.element)

      await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
      await flushPromises()
      dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
      const confirmButton = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.textContent?.trim() === '取消重建',
      )
      expect(confirmButton).toBeTruthy()
      confirmButton?.click()
      confirmButton?.click()
      await flushPromises()

      expect(mocks.cancelJob).toHaveBeenCalledTimes(1)
      expect(mocks.cancelJob).toHaveBeenCalledWith('job-b')
      expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
      expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
      expect(document.activeElement).toBe(header.element)
    },
  )

  it.each([
    ['ready', 'job-ready'],
    ['cancelled', 'job-cancelled'],
    ['pending', null],
  ] as const)('hides cancellation for desired state %s with job id %s', async (state, jobId) => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      desired_revision: {
        revision_id: 'rev-b',
        job_id: jobId,
        state,
        profile: readyProjection.available_profiles[1],
        chunks_done: 0,
        chunks_total: 225,
      },
    })

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
  })

  it('auto-expands only a failed activity, not normal background processing', async () => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'failed',
        processing_documents: 1,
        chunks_done: 135,
        chunks_total: 225,
      },
    })
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('需要处理')
  })

  it('describes a text-only actual state without repeating the current-state label', async () => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      selection: { kind: 'disabled' },
      active_revision: null,
    })
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

    const actual = wrapper.get('.kb-index-card__actual').text()
    expect(actual).toContain('当前使用 仅文本检索')
    expect(actual).not.toContain('当前使用 当前')
  })

  it('falls back to the existing local-install recovery only for unsupported old sidecars', async () => {
    const missing = Object.assign(new Error('Not Found'), { status: 404 })
    mocks.getPolicy.mockRejectedValueOnce(missing)
    mocks.unsupported.mockReturnValueOnce(true)
    mocks.getStatus.mockResolvedValueOnce({
      enabled: true,
      configured: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      local: true,
      ready: false,
      pulling: false,
    })
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('[data-testid="embedding-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="kb-semantic-index-card"]').exists()).toBe(false)
  })

  it('does not hide auth/server failures as an unsupported feature and offers retry', async () => {
    mocks.getPolicy.mockRejectedValueOnce(
      Object.assign(new Error('upstream failed'), { status: 500 }),
    )
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-semantic-index-error"]').text()).toContain(
      '暂时无法读取语义索引状态',
    )
    expect(mocks.getStatus).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="kb-semantic-index-retry"]').exists()).toBe(true)
  })

  it('polls persistent jobs and activity with a bounded loop, then stops after unmount', async () => {
    vi.useFakeTimers()
    const building = {
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    mocks.getPolicy.mockResolvedValue(building)
    const wrapper = mountCard()
    await flushPromises()

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushPromises()
    }

    expect(mocks.getPolicy.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.getPolicy.mock.calls.length).toBeLessThanOrEqual(21)
    const callsBeforeUnmount = mocks.getPolicy.mock.calls.length
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()
    expect(mocks.getPolicy).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('keeps refreshing a long-running activity after the initial backoff window', async () => {
    vi.useFakeTimers()
    mocks.getPolicy.mockResolvedValue({
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 1,
        chunks_total: 225,
      },
    })
    mountCard()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(120_000)
    await flushPromises()

    expect(mocks.getPolicy.mock.calls.length).toBeGreaterThan(21)
  })

  it('refreshes canonical policy even when a tracked job was already removed', async () => {
    vi.useFakeTimers()
    const rebuilding = {
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 135,
        chunks_total: 225,
      },
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 135,
        chunks_total: 225,
      },
    }
    mocks.getPolicy
      .mockResolvedValueOnce(rebuilding)
      .mockResolvedValue(structuredClone(readyProjection))
    mocks.getJob.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    mountCard()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(mocks.getJob).toHaveBeenCalledTimes(1)
    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(20_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenCalledTimes(1)
  })

  it('does not keep polling a failed desired revision with a terminal job id', async () => {
    vi.useFakeTimers()
    mocks.getPolicy.mockResolvedValue({
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'failed' as const,
        processing_documents: 0,
        chunks_done: 135,
        chunks_total: 225,
      },
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'failed' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 135,
        chunks_total: 225,
      },
    })
    const wrapper = mountCard()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(20_000)
    await flushPromises()

    expect(mocks.getJob).not.toHaveBeenCalled()
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('需要处理')
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).not.toContain('正在为')
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '文本可用 · 语义索引待重试',
    )
  })

  it.each([
    ['matching explicit failed desired', () => failedExplicitDesiredProjection(), 1],
    [
      'auto failed desired',
      () => ({ ...failedExplicitDesiredProjection(), selection: { kind: 'auto' as const } }),
      0,
    ],
    [
      'mismatched explicit profile failed desired',
      () => ({
        ...failedExplicitDesiredProjection(),
        selection: { kind: 'profile' as const, profile_id: 'cloud-sf' },
      }),
      0,
    ],
    [
      'retry_wait desired',
      () => {
        const projection = failedExplicitDesiredProjection()
        return {
          ...projection,
          indexing_activity: { ...projection.indexing_activity, state: 'retry_wait' as const },
          desired_revision: { ...projection.desired_revision, state: 'retry_wait' as const },
        }
      },
      0,
    ],
    [
      'building desired',
      () => {
        const projection = failedExplicitDesiredProjection()
        return {
          ...projection,
          indexing_activity: { ...projection.indexing_activity, state: 'building' as const },
          desired_revision: { ...projection.desired_revision, state: 'building' as const },
        }
      },
      0,
    ],
    [
      'ready desired',
      () => {
        const projection = failedExplicitDesiredProjection()
        return {
          ...projection,
          indexing_activity: { ...projection.indexing_activity, state: 'idle' as const },
          desired_revision: { ...projection.desired_revision, state: 'ready' as const },
        }
      },
      0,
    ],
    [
      'disabled selection',
      () => ({ ...failedExplicitDesiredProjection(), selection: { kind: 'disabled' as const } }),
      0,
    ],
  ])('shows a desired rebuild retry only for %s', async (_state, projection, expectedCount) => {
    mocks.getPolicy.mockResolvedValueOnce(projection())
    const wrapper = mountCard()
    await flushPromises()

    const retries = wrapper.findAll('[data-testid="kb-semantic-index-retry-rebuild"]')
    expect(retries).toHaveLength(expectedCount)
    if (expectedCount === 1) {
      expectNativeRetryButton(wrapper)
    }
  })

  it('retries a matching failed explicit profile once and follows only the canonical new job projection', async () => {
    vi.useFakeTimers()
    const failed = failedExplicitDesiredProjection()
    const rebuilding = {
      ...structuredClone(failed),
      policy_version: 9,
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 0,
        chunks_total: 225,
      },
      desired_revision: {
        ...structuredClone(failed.desired_revision),
        revision_id: 'rev-c',
        job_id: 'job-c',
        state: 'building' as const,
        chunks_done: 0,
        chunks_total: 225,
      },
    }
    const applying = deferred<{ job_id: string }>()
    mocks.getPolicy
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(rebuilding)
      .mockResolvedValue(rebuilding)
    mocks.applyPolicy.mockReturnValueOnce(applying.promise)

    const wrapper = mountCard()
    await flushPromises()
    const retry = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-retry-rebuild"]')
    retry.element.focus()
    expect(document.activeElement).toBe(retry.element)

    await retry.trigger('click')
    await retry.trigger('click')
    expect(mocks.applyPolicy).toHaveBeenCalledTimes(1)
    expect(retry.element.disabled).toBe(true)
    expect(mocks.cancelJob).not.toHaveBeenCalled()

    applying.resolve({ job_id: 'job-c' })
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 8, {
      kind: 'profile',
      profile_id: 'local-nomic',
    })
    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="kb-semantic-index-retry-rebuild"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '当前索引可用 · 新索引 0/225',
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenCalledWith('job-c')
  })

  it('keeps the failed projection and restores retry without an error detail when retry apply fails', async () => {
    const failed = failedExplicitDesiredProjection()
    mocks.getPolicy.mockResolvedValueOnce(failed)
    mocks.applyPolicy.mockRejectedValueOnce(new Error('retry failed'))
    const wrapper = mountCard()
    await flushPromises()

    const retry = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-retry-rebuild"]')
    await retry.trigger('click')
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 8, {
      kind: 'profile',
      profile_id: 'local-nomic',
    })
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('需要处理')
    const restoredRetry = wrapper.get<HTMLButtonElement>(
      '[data-testid="kb-semantic-index-retry-rebuild"]',
    )
    expect(restoredRetry.element.disabled).toBe(false)
    expect(wrapper.find('.kb-index-card__inline-error').exists()).toBe(false)
  })

  it('downloads a local profile once, keeps the menu open, and trusts the refreshed catalog', async () => {
    const pull = {
      reportProgress: null as
        | ((value: { status: string; completed?: number; total?: number }) => void)
        | null,
      finish: null as (() => void) | null,
    }
    mocks.pullModel.mockImplementation(
      (_model: string, onProgress: NonNullable<typeof pull.reportProgress>) =>
        new Promise<void>((resolve) => {
          pull.reportProgress = onProgress
          pull.finish = resolve
        }),
    )
    const installedProjection = structuredClone(readyProjection)
    installedProjection.available_profiles[2]!.availability = 'installed'
    mocks.getPolicy
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(installedProjection)

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    const trigger = wrapper.get('[data-testid="kb-index-model-trigger"]')
    await trigger.trigger('click')
    await flushPromises()

    let downloadable = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(downloadable?.getAttribute('aria-disabled')).toBeNull()
    downloadable?.click()
    await flushPromises()

    expect(mocks.pullModel).toHaveBeenCalledTimes(1)
    expect(mocks.pullModel.mock.calls[0]?.[0]).toBe('mxbai-embed-large')
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
    expect(trigger.attributes('aria-expanded')).toBe('true')

    pull.reportProgress?.({ status: 'downloading', completed: 0, total: 100 })
    await flushPromises()
    downloadable = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(downloadable?.textContent).toContain('下载中 0%')

    pull.reportProgress?.({ status: 'downloading', completed: 42, total: 100 })
    await flushPromises()
    downloadable = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(downloadable?.textContent).toContain('下载中 42%')
    expect(downloadable?.getAttribute('aria-disabled')).toBe('true')
    downloadable?.click()
    expect(mocks.pullModel).toHaveBeenCalledTimes(1)

    pull.reportProgress?.({ status: 'success' })
    pull.finish?.()
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    expect(trigger.attributes('aria-expanded')).toBe('true')
    const installed = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(installed?.textContent).toContain('已安装')
    expect(installed?.textContent).not.toContain('下载中')
    expect(mocks.applyPolicy).not.toHaveBeenCalled()

    installed?.click()
    await flushPromises()
    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 7, {
      kind: 'profile',
      profile_id: 'local-mxbai',
    })
  })

  it('keeps one Ollama pull across component remounts and refreshes the new projection owner', async () => {
    const pull = {
      finish: null as (() => void) | null,
    }
    mocks.pullModel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pull.finish = resolve
        }),
    )
    const installedProjection = structuredClone(readyProjection)
    installedProjection.available_profiles[2]!.availability = 'installed'
    mocks.getPolicy
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(installedProjection)

    const first = mountCard()
    await flushPromises()
    await first.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await first.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    const firstRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    firstRow?.click()
    await flushPromises()
    expect(mocks.pullModel).toHaveBeenCalledTimes(1)

    first.unmount()
    mountedWrappers.splice(mountedWrappers.indexOf(first), 1)

    const second = mountCard()
    await flushPromises()
    await second.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await second.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    const joinedRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(joinedRow?.textContent).toContain('下载中')
    expect(joinedRow?.getAttribute('aria-disabled')).toBe('true')
    joinedRow?.click()
    expect(mocks.pullModel).toHaveBeenCalledTimes(1)

    pull.finish?.()
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(3)
    const installed = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(installed?.textContent).toContain('已安装')
  })

  it('keeps downloading locked until a delayed canonical catalog reports installed', async () => {
    vi.useFakeTimers()
    mocks.pullModel.mockImplementation(
      async (_model: string, onProgress: (value: { status: string }) => void) => {
        onProgress({ status: 'success' })
      },
    )
    const installedProjection = structuredClone(readyProjection)
    installedProjection.available_profiles[2]!.availability = 'installed'
    mocks.getPolicy
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(installedProjection)

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('mxbai-embed-large'),
    )
    row?.click()
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    const verifying = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(verifying?.textContent).toContain('下载中 100%')
    expect(verifying?.getAttribute('aria-disabled')).toBe('true')

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(3)
    const installed = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    expect(installed?.textContent).toContain('已安装')
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
  })

  it('does not claim installation when a completed pull is still downloadable in canonical policy', async () => {
    vi.useFakeTimers()
    mocks.pullModel.mockImplementation(
      async (_model: string, onProgress: (value: { status: string }) => void) => {
        onProgress({ status: 'success' })
      },
    )
    mocks.getPolicy.mockResolvedValue(structuredClone(readyProjection))

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()
    const downloadable = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('mxbai-embed-large'),
    )
    downloadable?.click()
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('下载中')

    await vi.advanceTimersByTimeAsync(4_000)
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(6)
    expect(document.body.textContent).toContain('下载')
    expect(document.body.textContent).not.toContain('下载中')
    expect(wrapper.text()).not.toContain('已安装，可用于本地语义索引')
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
  })

  it('restores a failed download to an actionable row without inventing progress', async () => {
    const pull = {
      reportProgress: null as
        | ((value: { status: string; completed?: number; total?: number }) => void)
        | null,
    }
    mocks.pullModel.mockImplementation(
      (_model: string, onProgress: NonNullable<typeof pull.reportProgress>) => {
        pull.reportProgress = onProgress
        return Promise.reject(new Error('disk full'))
      },
    )

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()
    let row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('mxbai-embed-large'),
    )
    row?.click()
    pull.reportProgress?.({ status: 'pulling manifest', completed: 1, total: 0 })
    await flushPromises()

    row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('mxbai-embed-large'),
    )
    expect(row?.textContent).toContain('下载')
    expect(row?.textContent).not.toMatch(/\d+%/)
    expect(row?.getAttribute('aria-disabled')).toBeNull()
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain('disk full')
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
  })

  it('starts polling when an installed model refresh creates a desired revision', async () => {
    vi.useFakeTimers()
    mocks.pullModel.mockImplementation(
      async (_model: string, onProgress: (value: { status: string }) => void) => {
        onProgress({ status: 'success' })
      },
    )
    const installedAndBuilding = {
      ...structuredClone(readyProjection),
      policy_version: 8,
      available_profiles: readyProjection.available_profiles.map((profile) =>
        profile.profile_id === 'local-mxbai'
          ? { ...profile, availability: 'installed' as const }
          : profile,
      ),
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'pending' as const,
        profile: { ...readyProjection.available_profiles[2]!, availability: 'installed' as const },
        chunks_done: 0,
        chunks_total: 225,
      },
    }
    mocks.getPolicy
      .mockResolvedValueOnce(structuredClone(readyProjection))
      .mockResolvedValueOnce(installedAndBuilding)
      .mockResolvedValueOnce({ ...installedAndBuilding, policy_version: 9 })
    mocks.getJob.mockResolvedValueOnce({
      job_id: 'job-b',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 1,
      chunks_total: 225,
    })

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('mxbai-embed-large'),
    )
    row?.click()
    await flushPromises()
    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenCalledWith('job-b')
    expect(mocks.getPolicy).toHaveBeenCalledTimes(3)
  })

  it('does not let an older in-flight poll overwrite a completed cancellation refresh', async () => {
    vi.useFakeTimers()
    const desired = {
      ...structuredClone(readyProjection),
      policy_version: 8,
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    const stalePoll = {
      resolve: null as ((projection: typeof desired) => void) | null,
    }
    mocks.getPolicy
      .mockResolvedValueOnce(desired)
      .mockImplementationOnce(
        () =>
          new Promise<typeof desired>((resolve) => {
            stalePoll.resolve = resolve
          }),
      )
      .mockResolvedValueOnce({ ...structuredClone(readyProjection), policy_version: 9 })
    mocks.getJob.mockResolvedValueOnce({
      job_id: 'job-b',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 1,
      chunks_total: 225,
    })

    const wrapper = mountCard()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    const confirm = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === '取消重建')
    confirm?.click()
    await flushPromises()
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)

    stalePoll.resolve?.(desired)
    await flushPromises()
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')
  })

  it('keeps an operation error visible when a background policy poll succeeds', async () => {
    vi.useFakeTimers()
    const enhancing = {
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 1,
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    mocks.getPolicy.mockResolvedValue(enhancing)
    mocks.pullModel.mockRejectedValueOnce(new Error('disk full'))

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('mxbai-embed-large'),
    )
    row?.click()
    await flushPromises()
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain('disk full')

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain('disk full')
  })

  it('closes a stale cancellation confirmation instead of cancelling a replacement desired job', async () => {
    vi.useFakeTimers()
    const desiredB = {
      ...structuredClone(readyProjection),
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    const desiredC = {
      ...structuredClone(desiredB),
      desired_revision: {
        ...desiredB.desired_revision,
        revision_id: 'rev-c',
        job_id: 'job-c',
      },
    }
    mocks.getPolicy.mockResolvedValueOnce(desiredB).mockResolvedValueOnce(desiredC)
    mocks.getJob.mockResolvedValueOnce({
      job_id: 'job-b',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 1,
      chunks_total: 225,
    })

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(header.element)
  })

  it('returns focus to the header before a slow cancellation request completes', async () => {
    const desired = {
      ...structuredClone(readyProjection),
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 1,
        chunks_total: 225,
      },
    }
    const pendingCancel = { resolve: null as (() => void) | null }
    mocks.getPolicy
      .mockResolvedValueOnce(desired)
      .mockResolvedValueOnce(structuredClone(readyProjection))
    mocks.cancelJob.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingCancel.resolve = resolve
        }),
    )

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    const confirm = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === '取消重建')
    confirm?.click()
    await flushPromises()

    expect(mocks.cancelJob).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(header.element)

    pendingCancel.resolve?.()
    await flushPromises()
  })

  it('uses the approved modal focus and Escape contract for rebuild cancellation', async () => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 1,
        chunks_total: 225,
      },
    })

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    const header = wrapper.get<HTMLButtonElement>('[data-testid="kb-semantic-index-header"]')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    let appRoot = wrapper.element as HTMLElement
    while (appRoot.parentElement && appRoot.parentElement !== document.body) {
      appRoot = appRoot.parentElement
    }
    expect(dialog).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    expect(dialog?.getAttribute('aria-describedby')).toBeTruthy()
    expect(appRoot.inert).toBe(true)
    const modalButtons = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(modalButtons[0])
    modalButtons[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    )
    expect(document.activeElement).toBe(modalButtons[modalButtons.length - 1])
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(appRoot.inert).toBe(false)
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(header.element)
  })

  it.each([
    ['en', en.knowledge.semanticIndex],
    ['ug-CN', ugCN.knowledge.semanticIndex],
  ] as const)(
    'renders desired retry_wait as waiting, not active building progress, in %s',
    async (locale, messages) => {
      mocks.getPolicy.mockResolvedValueOnce({
        ...structuredClone(readyProjection),
        indexing_activity: {
          state: 'retry_wait' as const,
          processing_documents: 0,
          chunks_done: 42,
          chunks_total: 225,
        },
        desired_revision: {
          revision_id: 'rev-b',
          job_id: 'job-b',
          state: 'retry_wait' as const,
          profile: readyProjection.available_profiles[1],
          chunks_done: 42,
          chunks_total: 225,
        },
      })

      const wrapper = mountCard(locale)
      await flushPromises()
      await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

      expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe(messages.retrying)
      expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
        messages.semanticRetryWaiting,
      )
    },
  )

  it.each([
    ['en', en.knowledge.semanticIndex],
    ['ug-CN', ugCN.knowledge.semanticIndex],
  ] as const)(
    'does not claim hybrid readiness without an active semantic revision in %s',
    async (locale, messages) => {
      mocks.getPolicy.mockResolvedValueOnce({
        ...structuredClone(readyProjection),
        active_revision: null,
        recommendation: {
          profile_id: null,
          reason_code: 'embedding_unavailable',
          reason_text: '后端中文理由绝不能泄漏',
        },
      })

      const wrapper = mountCard(locale)
      await flushPromises()
      await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

      const actual = wrapper.get('[data-testid="kb-semantic-index-actual"]').text()
      expect(actual).toContain(messages.textOnlyReady)
      expect(actual).not.toContain(messages.hybridReady)
      expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).not.toMatch(
        /[\u3400-\u9fff]/u,
      )
    },
  )

  it.each([
    [1, '1 item processing', 'Current index available · enhancing 1 document'],
    [3, '3 items processing', 'Current index available · enhancing 3 documents'],
  ] as const)('uses grammatical English document counts for %s', async (count, summary, actual) => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: count,
        chunks_done: count,
        chunks_total: 225,
      },
    })

    const wrapper = mountCard('en')
    await flushPromises()
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe(summary)
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(actual)
  })

  it('keeps numeric progress out of the live region until the semantic phase changes', async () => {
    vi.useFakeTimers()
    const building42 = {
      ...structuredClone(readyProjection),
      indexing_activity: {
        state: 'building' as const,
        processing_documents: 3,
        chunks_done: 42,
        chunks_total: 225,
      },
      desired_revision: {
        revision_id: 'rev-b',
        job_id: 'job-b',
        state: 'building' as const,
        profile: readyProjection.available_profiles[1],
        chunks_done: 42,
        chunks_total: 225,
      },
    }
    const building43 = {
      ...structuredClone(building42),
      indexing_activity: { ...building42.indexing_activity, chunks_done: 43 },
      desired_revision: { ...building42.desired_revision, chunks_done: 43 },
    }
    mocks.getPolicy
      .mockResolvedValueOnce(building42)
      .mockResolvedValueOnce(building43)
      .mockResolvedValueOnce(structuredClone(readyProjection))

    const wrapper = mountCard()
    await flushPromises()
    const liveRegion = wrapper.get('[aria-live="polite"]')
    const firstAnnouncement = liveRegion.text()
    expect(firstAnnouncement).not.toContain('42/225')

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(liveRegion.text()).toBe(firstAnnouncement)
    expect(liveRegion.text()).not.toContain('43/225')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()
    expect(liveRegion.text()).not.toBe(firstAnnouncement)
    expect(liveRegion.text()).toContain('文本 + 语义已就绪')
  })

  it('keeps semantic-index locale keys aligned and does not leak Chinese backend reasons', async () => {
    const semanticMessages = (messages: typeof zhCN) => messages.knowledge.semanticIndex
    const expectedKeys = Object.keys(semanticMessages(zhCN)).sort()
    expect(Object.keys(semanticMessages(en as typeof zhCN)).sort()).toEqual(expectedKeys)
    expect(Object.keys(semanticMessages(ugCN as typeof zhCN)).sort()).toEqual(expectedKeys)
    const placeholders = (value: string) =>
      [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()
    for (const key of expectedKeys) {
      const zhValue = semanticMessages(zhCN)[key as keyof ReturnType<typeof semanticMessages>]
      const enValue = semanticMessages(en as typeof zhCN)[
        key as keyof ReturnType<typeof semanticMessages>
      ]
      const ugValue = semanticMessages(ugCN as typeof zhCN)[
        key as keyof ReturnType<typeof semanticMessages>
      ]
      expect(placeholders(String(enValue)), `en placeholder drift: ${key}`).toEqual(
        placeholders(String(zhValue)),
      )
      expect(placeholders(String(ugValue)), `ug-CN placeholder drift: ${key}`).toEqual(
        placeholders(String(zhValue)),
      )
    }

    for (const locale of ['en', 'ug-CN']) {
      mocks.getPolicy.mockResolvedValueOnce({
        ...structuredClone(readyProjection),
        recommendation: {
          profile_id: 'cloud-sf',
          reason_code: 'configured_embedding',
          reason_text: '后端中文理由绝不能泄漏',
        },
        indexing_activity: {
          state: 'building' as const,
          processing_documents: 3,
          chunks_done: 42,
          chunks_total: 225,
        },
        desired_revision: {
          revision_id: 'rev-b',
          job_id: 'job-b',
          state: 'building' as const,
          profile: readyProjection.available_profiles[1],
          chunks_done: 42,
          chunks_total: 225,
        },
      })
      const wrapper = mountCard(locale)
      await flushPromises()
      await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
      await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
      await flushPromises()

      const visible = `${wrapper.text()} ${document.body.querySelector('[role="dialog"]')?.textContent ?? ''}`
      expect(visible).not.toMatch(/[\u3400-\u9fff]/u)
      expect(visible).not.toContain('（')
      expect(visible).not.toContain('；')
      expect(visible).not.toContain('knowledge.semanticIndex')
      expect(visible).not.toContain('undefined')

      const continueButton = [
        ...(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button') ?? []),
      ][0]
      continueButton?.click()
      await flushPromises()
      wrapper.unmount()
      document.body.innerHTML = ''
    }
  })

  it.each(['en', 'ug-CN'])('localizes every recommendation reason_code in %s', async (locale) => {
    const reasonKeys = {
      configured_embedding: 'recommendationConfigured',
      local_model_download: 'recommendationLocalDownload',
      embedding_unavailable: 'recommendationUnavailable',
      unexpected_reason: 'recommendationGeneric',
    } as const
    const localeMessages =
      locale === 'en' ? en.knowledge.semanticIndex : ugCN.knowledge.semanticIndex

    for (const [reasonCode, messageKey] of Object.entries(reasonKeys)) {
      mocks.getPolicy.mockResolvedValueOnce({
        ...structuredClone(readyProjection),
        recommendation: {
          profile_id: 'cloud-sf',
          reason_code: reasonCode,
          reason_text: '后端中文理由绝不能泄漏',
        },
      })
      const wrapper = mountCard(locale)
      await flushPromises()
      await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

      const hint = wrapper.get('[data-testid="kb-semantic-index-hint"]').text()
      expect(hint).toContain(String(localeMessages[messageKey]))
      expect(hint).not.toMatch(/[\u3400-\u9fff]/u)
      expect(hint).not.toContain('后端中文理由绝不能泄漏')

      wrapper.unmount()
      document.body.innerHTML = ''
    }
  })
})
