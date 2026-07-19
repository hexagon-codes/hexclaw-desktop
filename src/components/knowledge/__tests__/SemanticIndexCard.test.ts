import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  applyPolicy: vi.fn(),
  unsupported: vi.fn(),
  getStatus: vi.fn(),
  pullModel: vi.fn(),
}))

vi.mock('@/api/knowledge-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getKnowledgeEmbeddingPolicy: (...args: unknown[]) => mocks.getPolicy(...args),
  applyKnowledgeEmbeddingPolicy: (...args: unknown[]) => mocks.applyPolicy(...args),
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

function i18n() {
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
    global: { plugins: [i18n()] },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

describe('SemanticIndexCard', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
    mocks.getPolicy.mockResolvedValue(structuredClone(readyProjection))
    mocks.applyPolicy.mockResolvedValue({
      policy_version: 8,
      selection: { kind: 'profile', profile_id: 'local-nomic' },
      active_revision_id: 'rev-a',
      desired_revision_id: 'rev-b',
      job_id: 'job-b',
    })
    mocks.unsupported.mockReturnValue(false)
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
    document.body.innerHTML = ''
  })

  it('is collapsed by default and keeps selection, actual model and real state in the summary', async () => {
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.get('[data-testid="kb-semantic-index-card"]').text()).toContain('语义索引')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('自动')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('SiliconFlow')
    expect(wrapper.get('[data-testid="kb-semantic-index-summary"]').text()).toContain('已就绪')
    expect(wrapper.text()).not.toContain('语义索引（高级）')
    expect(wrapper.find('[data-testid="kb-semantic-index-body"]').exists()).toBe(false)
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

  it('keeps the old active revision visible while a desired revision is building', async () => {
    mocks.getPolicy.mockResolvedValueOnce({
      ...structuredClone(readyProjection),
      selection: { kind: 'profile', profile_id: 'local-nomic' },
      desired_revision: {
        revision_id: 'rev-b',
        state: 'building',
        profile: readyProjection.available_profiles[1],
        chunks_done: 135,
        chunks_total: 225,
      },
    })
    const wrapper = mountCard()
    await flushPromises()

    const summary = wrapper.get('[data-testid="kb-semantic-index-summary"]').text()
    expect(summary).toContain('SiliconFlow')
    expect(summary).toContain('当前使用 BAAI/bge-m3')
    expect(summary).toContain('135/225')
    expect(summary).not.toContain('nomic-embed-text · 已就绪')

    await wrapper.get('[data-testid="kb-semantic-index-header"]').trigger('click')
    expect(
      wrapper.get('[data-testid="kb-index-model-trigger"]').attributes('aria-disabled'),
    ).toBeUndefined()
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
})
