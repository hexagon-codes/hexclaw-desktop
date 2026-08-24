import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import type {
  EmbeddingProfile,
  KnowledgeEmbeddingPolicyProjection,
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

const cloudProfile: EmbeddingProfile = {
  profile_id: 'cloud-sf',
  model_name: 'BAAI/bge-m3',
  provider_id: 'siliconflow',
  provider_name: 'SiliconFlow',
  location: 'cloud',
  capability: 'embedding',
  dimension: 1024,
  availability: 'connected',
  display_order: 10,
}

const installedLocalProfile: EmbeddingProfile = {
  profile_id: 'local-nomic',
  model_name: 'nomic-embed-text',
  provider_id: 'ollama',
  provider_name: 'Ollama',
  location: 'local',
  capability: 'embedding',
  dimension: 768,
  availability: 'installed',
  display_order: 20,
}

const downloadableLocalProfile: EmbeddingProfile = {
  profile_id: 'local-mxbai',
  model_name: 'mxbai-embed-large',
  provider_id: 'ollama',
  provider_name: 'Ollama',
  location: 'local',
  capability: 'embedding',
  dimension: 1024,
  availability: 'downloadable',
  display_order: 30,
}

function baseProjection(): KnowledgeEmbeddingPolicyProjection {
  return {
    policy_version: 7,
    selection: { kind: 'auto' },
    indexing_activity: {
      state: 'idle',
      processing_documents: 0,
      chunks_done: 225,
      chunks_total: 225,
    },
    catalog_version: 3,
    recommendation: {
      profile_id: cloudProfile.profile_id,
      reason_code: 'configured_embedding',
      reason_text: 'ignored backend display text',
    },
    available_profiles: [
      structuredClone(cloudProfile),
      structuredClone(installedLocalProfile),
      structuredClone(downloadableLocalProfile),
    ],
    active_revision: {
      revision_id: 'rev-cloud',
      profile_config_hash: 'profile-hash-cloud-active',
      state: 'ready',
      profile: structuredClone(cloudProfile),
      chunks_done: 225,
      chunks_total: 225,
    },
    desired_revision: null,
  }
}

function withDownloadedModel(
  projection: KnowledgeEmbeddingPolicyProjection,
  version: number,
): KnowledgeEmbeddingPolicyProjection {
  const next = structuredClone(projection)
  next.policy_version = version
  next.catalog_version += 1
  next.available_profiles = next.available_profiles.map((profile) =>
    profile.profile_id === downloadableLocalProfile.profile_id
      ? { ...profile, availability: 'installed' }
      : profile,
  )
  return next
}

function withDesiredLocal(
  projection: KnowledgeEmbeddingPolicyProjection,
  profileId: 'local-nomic' | 'local-mxbai',
  version: number,
  jobId: string,
): KnowledgeEmbeddingPolicyProjection {
  const next = structuredClone(projection)
  const profile = next.available_profiles.find((candidate) => candidate.profile_id === profileId)
  if (!profile) throw new Error(`missing fixture profile: ${profileId}`)
  next.policy_version = version
  next.selection = { kind: 'profile', profile_id: profileId }
  next.indexing_activity = {
    state: 'building',
    processing_documents: 1,
    chunks_done: 0,
    chunks_total: 225,
  }
  next.desired_revision = {
    revision_id: `rev-${profileId}`,
    profile_config_hash: `profile-hash-${profileId}`,
    job_id: jobId,
    state: 'building',
    profile: structuredClone(profile),
    chunks_done: 0,
    chunks_total: 225,
  }
  return next
}

function restoredCloudProjection(version: number): KnowledgeEmbeddingPolicyProjection {
  const next = withDownloadedModel(baseProjection(), version)
  next.selection = { kind: 'auto' }
  next.indexing_activity = {
    state: 'idle',
    processing_documents: 0,
    chunks_done: 225,
    chunks_total: 225,
  }
  next.desired_revision = null
  return next
}

function optionFor(modelName: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes(modelName),
  )
}

async function openModelMenu(wrapper: VueWrapper) {
  await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
  await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
  await flushPromises()
}

function mountCard() {
  return mount(SemanticIndexCard, {
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: false,
          messages: { 'zh-CN': zhCN },
        }),
      ],
    },
    attachTo: document.body,
  })
}

let wrapper: VueWrapper | null = null

describe('SemanticIndexCard local-model user journeys', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetAllMocks()
    mocks.unsupported.mockReturnValue(false)
    mocks.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      provider: 'ollama',
      model: installedLocalProfile.model_name,
      local: true,
      ready: true,
      pulling: false,
    })
    mocks.getJob.mockResolvedValue({
      job_id: 'job-local',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 0,
      chunks_total: 225,
    })
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    await flushPromises()
    document.body.innerHTML = ''
  })

  it('recovers from a failed pull, requires explicit apply, and can cancel the local rebuild', async () => {
    const initial = baseProjection()
    const installed = withDownloadedModel(initial, 8)
    const rebuilding = withDesiredLocal(installed, 'local-mxbai', 9, 'job-local-mxbai')
    const restored = restoredCloudProjection(10)

    mocks.getPolicy
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce(rebuilding)
      .mockResolvedValueOnce(restored)
    mocks.pullModel
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(
        async (_model: string, onProgress: (progress: { status: string }) => void) => {
          onProgress({ status: 'success' })
        },
      )
    mocks.applyPolicy.mockResolvedValue({
      policy_version: 9,
      selection: { kind: 'profile', profile_id: 'local-mxbai' },
      active_revision_id: 'rev-cloud',
      desired_revision_id: 'rev-local-mxbai',
      job_id: 'job-local-mxbai',
    })
    mocks.cancelJob.mockResolvedValue({
      job_id: 'job-local-mxbai',
      state: 'cancelled',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 0,
      chunks_total: 225,
    })

    wrapper = mountCard()
    await flushPromises()
    await openModelMenu(wrapper)

    optionFor(downloadableLocalProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.pullModel).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.kb-index-card__inline-error').text()).toContain('disk full')
    expect(optionFor(downloadableLocalProfile.model_name)?.textContent).toContain('下载')
    expect(optionFor(downloadableLocalProfile.model_name)?.getAttribute('aria-disabled')).toBeNull()
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-expanded')).toBe(
      'true',
    )

    optionFor(downloadableLocalProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.pullModel).toHaveBeenCalledTimes(2)
    expect(mocks.applyPolicy).not.toHaveBeenCalled()
    expect(optionFor(downloadableLocalProfile.model_name)?.textContent).toContain('已安装')
    expect(wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-expanded')).toBe(
      'true',
    )

    optionFor(downloadableLocalProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.applyPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 8, {
      kind: 'profile',
      profile_id: 'local-mxbai',
    })
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'Ollama · mxbai-embed-large',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )

    await wrapper.get('[data-testid="kb-semantic-index-cancel"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const confirm = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '取消重建',
    )
    expect(confirm).toBeTruthy()
    confirm?.click()
    await flushPromises()

    expect(mocks.cancelJob).toHaveBeenCalledTimes(1)
    expect(mocks.cancelJob).toHaveBeenCalledWith('job-local-mxbai')
    expect(wrapper.find('[data-testid="kb-semantic-index-cancel"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="kb-semantic-index-actual"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('自动')
  })

  it('keeps an in-flight download independent from switching to another installed local model', async () => {
    const initial = baseProjection()
    const rebuildingNomic = withDesiredLocal(initial, 'local-nomic', 8, 'job-local-nomic')
    const downloadedWhileRebuilding = withDownloadedModel(rebuildingNomic, 9)
    let reportProgress: (progress: {
      status: string
      completed?: number
      total?: number
    }) => void = () => {
      throw new Error('pull progress callback was not registered')
    }
    let finishPull: () => void = () => {
      throw new Error('pull completion callback was not registered')
    }

    mocks.getPolicy
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(rebuildingNomic)
      .mockResolvedValueOnce(downloadedWhileRebuilding)
    mocks.pullModel.mockImplementation(
      (
        _model: string,
        onProgress: (progress: { status: string; completed?: number; total?: number }) => void,
      ) =>
        new Promise<void>((resolve) => {
          reportProgress = onProgress
          finishPull = resolve
        }),
    )
    mocks.applyPolicy.mockResolvedValue({
      policy_version: 8,
      selection: { kind: 'profile', profile_id: 'local-nomic' },
      active_revision_id: 'rev-cloud',
      desired_revision_id: 'rev-local-nomic',
      job_id: 'job-local-nomic',
    })

    wrapper = mountCard()
    await flushPromises()
    await openModelMenu(wrapper)

    optionFor(downloadableLocalProfile.model_name)?.click()
    await flushPromises()
    reportProgress({ status: 'downloading', completed: 42, total: 100 })
    await flushPromises()
    expect(optionFor(downloadableLocalProfile.model_name)?.textContent).toContain('下载中 42%')

    optionFor(installedLocalProfile.model_name)?.click()
    await flushPromises()

    expect(mocks.pullModel).toHaveBeenCalledTimes(1)
    expect(mocks.applyPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.applyPolicy).toHaveBeenCalledWith('default', 7, {
      kind: 'profile',
      profile_id: 'local-nomic',
    })
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      'nomic-embed-text',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )

    reportProgress({ status: 'success' })
    finishPull()
    await flushPromises()

    expect(mocks.getPolicy).toHaveBeenCalledTimes(3)
    expect(mocks.pullModel).toHaveBeenCalledTimes(1)
    expect(mocks.applyPolicy).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain(
      'nomic-embed-text',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).not.toContain(
      'mxbai-embed-large',
    )
    expect(wrapper.get('[data-testid="kb-semantic-index-hint"]').text()).toContain(
      'SiliconFlow · BAAI/bge-m3',
    )
  })
})
