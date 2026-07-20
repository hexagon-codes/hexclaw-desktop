import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import type {
  KnowledgeEmbeddingPolicyProjection,
  KnowledgeEmbeddingProfile,
} from '@/api/knowledge-index'

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

const siliconFlowProfile: KnowledgeEmbeddingProfile = {
  profile_id: 'cloud-siliconflow-bge-m3',
  model_name: 'BAAI/bge-m3',
  provider_id: 'siliconflow',
  provider_name: 'SiliconFlow',
  location: 'cloud',
  capability: 'embedding',
  dimension: 1024,
  availability: 'connected',
  display_order: 10,
}

const openAIProfile: KnowledgeEmbeddingProfile = {
  profile_id: 'cloud-openai-small',
  model_name: 'text-embedding-3-small',
  provider_id: 'openai-compatible',
  provider_name: 'OpenAI Compatible',
  location: 'cloud',
  capability: 'embedding',
  dimension: 1536,
  availability: 'connected',
  display_order: 20,
}

function readyAutoProjection(version = 10): KnowledgeEmbeddingPolicyProjection {
  return {
    policy_version: version,
    selection: { kind: 'auto' },
    indexing_activity: {
      state: 'idle',
      processing_documents: 0,
      chunks_done: 320,
      chunks_total: 320,
    },
    catalog_version: 4,
    recommendation: {
      profile_id: siliconFlowProfile.profile_id,
      reason_code: 'configured_embedding',
      reason_text: 'server-owned text must not drive presentation',
    },
    available_profiles: [siliconFlowProfile, openAIProfile],
    active_revision: {
      revision_id: 'revision-siliconflow-active',
      state: 'ready',
      profile: siliconFlowProfile,
      chunks_done: 320,
      chunks_total: 320,
    },
    desired_revision: null,
  }
}

function readyOpenAIProjection(version = 20): KnowledgeEmbeddingPolicyProjection {
  return {
    ...readyAutoProjection(version),
    selection: { kind: 'profile', profile_id: openAIProfile.profile_id },
    recommendation: {
      profile_id: siliconFlowProfile.profile_id,
      reason_code: 'configured_embedding',
      reason_text: 'server-owned text must not drive presentation',
    },
    active_revision: {
      revision_id: 'revision-openai-active',
      state: 'ready',
      profile: openAIProfile,
      chunks_done: 320,
      chunks_total: 320,
    },
  }
}

function desiredOpenAIProjection(
  state: 'pending' | 'building' | 'retry_wait' | 'failed',
  version = 11,
  chunksDone = 0,
): KnowledgeEmbeddingPolicyProjection {
  return {
    ...readyAutoProjection(version),
    selection: { kind: 'profile', profile_id: openAIProfile.profile_id },
    indexing_activity: {
      state:
        state === 'retry_wait' ? 'retry_wait' : state === 'failed' ? 'failed' : 'building',
      processing_documents: state === 'failed' || state === 'retry_wait' ? 0 : 1,
      chunks_done: chunksDone,
      chunks_total: 320,
    },
    desired_revision: {
      revision_id: 'revision-openai-desired',
      job_id: 'job-cloud-openai',
      state,
      profile: openAIProfile,
      chunks_done: chunksDone,
      chunks_total: 320,
    },
  }
}

function desiredAutoProjection(version = 21): KnowledgeEmbeddingPolicyProjection {
  const current = readyOpenAIProjection(version)
  return {
    ...current,
    selection: { kind: 'auto' },
    indexing_activity: {
      state: 'building',
      processing_documents: 1,
      chunks_done: 0,
      chunks_total: 320,
    },
    desired_revision: {
      revision_id: 'revision-auto-desired',
      job_id: 'job-cloud-auto',
      state: 'pending',
      profile: siliconFlowProfile,
      chunks_done: 0,
      chunks_total: 320,
    },
  }
}

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

const mountedWrappers: ReturnType<typeof mount>[] = []

function mountCard() {
  const wrapper = mount(SemanticIndexCard, {
    global: { plugins: [testI18n()] },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

async function expandAndOpenPicker(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
  await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
  await flushPromises()
}

function optionFor(model: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes(model),
  )
}

function autoOption(): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) =>
      option.querySelector<HTMLElement>('.kb-profile-select__option-title')?.textContent === '自动',
  )
}

function confirmCancelButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent?.trim() === '取消重建',
  )
}

describe('SemanticIndexCard cloud-model user journeys', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetAllMocks()
    mocks.getPolicy.mockResolvedValue(readyAutoProjection())
    mocks.applyPolicy.mockResolvedValue({
      policy_version: 11,
      selection: { kind: 'profile', profile_id: openAIProfile.profile_id },
      active_revision_id: 'revision-siliconflow-active',
      desired_revision_id: 'revision-openai-desired',
      job_id: 'job-cloud-openai',
    })
    mocks.getJob.mockResolvedValue({
      job_id: 'job-cloud-openai',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 0,
      chunks_total: 320,
    })
    mocks.cancelJob.mockResolvedValue({
      job_id: 'job-cloud-openai',
      state: 'cancelled',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 0,
      chunks_total: 320,
    })
    mocks.unsupported.mockReturnValue(false)
    mocks.getStatus.mockResolvedValue({
      enabled: false,
      configured: false,
      provider: '',
      model: '',
      local: false,
      ready: false,
      pulling: false,
    })
    mocks.pullModel.mockImplementation(() => {
      throw new Error('cloud journeys must never start an Ollama pull')
    })
  })

  afterEach(async () => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    await flushPromises()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('loads auto routing through the canonical cloud profile without writing policy or touching Ollama', async () => {
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      '自动 · SiliconFlow',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')

    await expandAndOpenPicker(wrapper)

    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '文本 + 语义已就绪',
    )
    expect(optionFor(openAIProfile.model_name)?.getAttribute('aria-disabled')).toBeNull()
    expect(optionFor(openAIProfile.model_name)?.textContent).toContain('已配置')
    expect(document.body.textContent).toContain('索引文本和查询文本会发送至该服务商')
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
    expect(mocks.getJob).not.toHaveBeenCalled()
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('switches from auto cloud routing to an explicit cloud model and follows the rebuild to ready', async () => {
    vi.useFakeTimers()
    const pending = desiredOpenAIProjection('pending', 11, 0)
    const running = desiredOpenAIProjection('building', 11, 128)
    const ready = readyOpenAIProjection(12)
    mocks.getPolicy
      .mockResolvedValueOnce(readyAutoProjection(10))
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(ready)
    mocks.getJob
      .mockResolvedValueOnce({
        job_id: 'job-cloud-openai',
        state: 'running',
        stage: 'embedding',
        pages_done: null,
        pages_total: null,
        chunks_done: 128,
        chunks_total: 320,
      })
      .mockResolvedValueOnce({
        job_id: 'job-cloud-openai',
        state: 'succeeded',
        stage: 'publishing',
        pages_done: null,
        pages_total: null,
        chunks_done: 320,
        chunks_total: 320,
      })

    const wrapper = mountCard()
    await flushPromises()
    await expandAndOpenPicker(wrapper)
    optionFor(openAIProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 10, {
      kind: 'profile',
      profile_id: openAIProfile.profile_id,
    })
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      `目标 · ${openAIProfile.model_name}`,
    )
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3 · 继续服务',
    )
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenNthCalledWith(1, 'job-cloud-openai')
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '新索引 128/320',
    )

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenNthCalledWith(2, 'job-cloud-openai')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      `${openAIProfile.model_name} · 云端`,
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      `OpenAI Compatible · ${openAIProfile.model_name}`,
    )
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      undefined,
    )
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('switches an explicit cloud model back to auto using only auto intent and stages the recommendation', async () => {
    const pendingAuto = desiredAutoProjection(21)
    mocks.getPolicy
      .mockResolvedValueOnce(readyOpenAIProjection(20))
      .mockResolvedValueOnce(pendingAuto)
    mocks.applyPolicy.mockResolvedValueOnce({
      policy_version: 21,
      selection: { kind: 'auto' },
      active_revision_id: 'revision-openai-active',
      desired_revision_id: 'revision-auto-desired',
      job_id: 'job-cloud-auto',
    })

    const wrapper = mountCard()
    await flushPromises()
    await expandAndOpenPicker(wrapper)
    autoOption()?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 20, { kind: 'auto' })
    expect(mocks.applyPolicy.mock.calls[0]?.[2]).not.toHaveProperty('profile_id')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      `目标 · ${siliconFlowProfile.model_name}`,
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      `OpenAI Compatible · ${openAIProfile.model_name} · 继续服务`,
    )
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      'true',
    )
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('presents a cloud retry_wait as waiting while the active cloud index keeps serving', async () => {
    vi.useFakeTimers()
    const retrying = desiredOpenAIProjection('retry_wait', 11, 128)
    mocks.getPolicy.mockResolvedValue(retrying)
    mocks.getJob.mockResolvedValueOnce({
      job_id: 'job-cloud-openai',
      state: 'retry_wait',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 128,
      chunks_total: 320,
      last_error: 'provider throttled',
    })

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')

    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('等待重试')
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'OpenAI Compatible · text-embedding-3-small · 新索引等待重试',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3 继续服务',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      '当前索引可用 · 等待重试',
    )
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(mocks.getJob).toHaveBeenCalledWith('job-cloud-openai')
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('keeps a failed cloud desired revision actionable without polling a terminal failure', async () => {
    vi.useFakeTimers()
    mocks.getPolicy.mockResolvedValue(desiredOpenAIProjection('failed', 11, 128))

    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('需要处理')
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'OpenAI Compatible · text-embedding-3-small · 文本可用，语义索引待重试',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3 继续服务',
    )
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.getJob).not.toHaveBeenCalled()
  })

  it('cancels the exact cloud rebuild job and returns to the canonical serving cloud index', async () => {
    vi.useFakeTimers()
    mocks.getPolicy
      .mockResolvedValueOnce(desiredOpenAIProjection('building', 11, 128))
      .mockResolvedValueOnce(readyAutoProjection(12))

    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    await flushPromises()

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    confirmCancelButton()?.click()
    await flushPromises()

    expect(mocks.cancelJob).toHaveBeenCalledTimes(1)
    expect(mocks.cancelJob).toHaveBeenCalledWith('job-cloud-openai')
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      '自动 · SiliconFlow',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('does not resurrect a cloud desired revision when an older poll resolves after cancellation', async () => {
    vi.useFakeTimers()
    const staleDesired = desiredOpenAIProjection('building', 11, 128)
    let resolveStalePoll: ((projection: KnowledgeEmbeddingPolicyProjection) => void) | undefined
    mocks.getPolicy
      .mockResolvedValueOnce(staleDesired)
      .mockImplementationOnce(
        () =>
          new Promise<KnowledgeEmbeddingPolicyProjection>((resolve) => {
            resolveStalePoll = resolve
          }),
      )
      .mockResolvedValueOnce(readyAutoProjection(12))

    const wrapper = mountCard()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    confirmCancelButton()?.click()
    await flushPromises()

    expect(mocks.cancelJob).toHaveBeenCalledWith('job-cloud-openai')
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)

    resolveStalePoll?.(staleDesired)
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      '自动 · SiliconFlow',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).not.toContain(
      openAIProfile.model_name,
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-status"]').text()).toBe('已就绪')
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
  })

  it('keeps the current cloud policy usable when applying another cloud model fails', async () => {
    mocks.applyPolicy.mockRejectedValueOnce(new Error('cloud provider unavailable'))

    const wrapper = mountCard()
    await flushPromises()
    await expandAndOpenPicker(wrapper)
    optionFor(openAIProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 10, {
      kind: 'profile',
      profile_id: openAIProfile.profile_id,
    })
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain(
      'cloud provider unavailable',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      '自动 · SiliconFlow',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      undefined,
    )
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })

  it('refreshes the canonical cloud policy after a version conflict and asks the user to choose again', async () => {
    const externallyUpdated = {
      ...readyAutoProjection(11),
      selection: { kind: 'profile' as const, profile_id: siliconFlowProfile.profile_id },
    }
    mocks.getPolicy
      .mockResolvedValueOnce(readyAutoProjection(10))
      .mockResolvedValueOnce(externallyUpdated)
    mocks.applyPolicy.mockRejectedValueOnce(
      Object.assign(new Error('stale expected_policy_version'), { status: 409 }),
    )

    const wrapper = mountCard()
    await flushPromises()
    await expandAndOpenPicker(wrapper)
    optionFor(openAIProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 10, {
      kind: 'profile',
      profile_id: openAIProfile.profile_id,
    })
    expect(mocks.getPolicy).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain(
      '设置已在其他位置更新，请重新选择。',
    )
    expect(wrapper.get('.kb-index-card__inline-error').text()).not.toContain(
      'stale expected_policy_version',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      `${siliconFlowProfile.model_name} · 云端`,
    )
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled')).toBe(
      undefined,
    )
    expect(mocks.pullModel).not.toHaveBeenCalled()
  })
})
