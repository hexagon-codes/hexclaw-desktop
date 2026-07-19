import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import EmbeddingProfileSelect from '../EmbeddingProfileSelect.vue'
import type { EmbeddingProfile, EmbeddingSelection } from '@/api/knowledge-index'

const profiles: EmbeddingProfile[] = [
  {
    profile_id: 'cloud-sf',
    model_name: 'BAAI/bge-m3',
    provider_id: 'siliconflow',
    provider_name: 'SiliconFlow',
    location: 'cloud',
    capability: 'embedding',
    dimension: 1024,
    availability: 'connected',
    display_order: 10,
  },
  {
    profile_id: 'local-nomic',
    model_name: 'nomic-embed-text',
    provider_id: 'ollama',
    provider_name: 'Ollama',
    location: 'local',
    capability: 'embedding',
    dimension: 768,
    availability: 'installed',
    display_order: 20,
  },
  {
    profile_id: 'local-mxbai',
    model_name: 'mxbai-embed-large',
    provider_id: 'ollama',
    provider_name: 'Ollama',
    location: 'local',
    capability: 'embedding',
    dimension: 1024,
    availability: 'downloadable',
    display_order: 30,
  },
]

const mountedWrappers: ReturnType<typeof mount>[] = []

function mountSelect(selection: EmbeddingSelection = { kind: 'auto' }) {
  const wrapper = mount(EmbeddingProfileSelect, {
    props: {
      selection,
      profiles,
      recommendationProfileId: 'cloud-sf',
      labels: {
        selectLabel: '索引模型',
        auto: '自动',
        recommended: '推荐',
        cloudGroup: '云端模型',
        localGroup: '本地模型',
        textOnly: '仅文本检索',
        local: '本地',
        cloud: '云端',
        installed: '已安装',
        connected: '已配置',
        unavailable: '不可用',
      },
      providerNotice:
        '云端模型由你配置的第三方 Provider 提供。HexClaw 仅负责连接与调用；索引文本和查询文本会发送至该服务商，计费与数据处理规则以其为准。',
      providerDocsLabel: '查看第三方 AI 服务说明 ↗',
      providerDocsAriaLabel: '查看第三方 AI 服务说明（在新窗口打开）',
      providerDocsUrl: 'https://hexclaw.net/zh/third-party-ai-services',
    },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

afterEach(async () => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
  await flushPromises()
  document.body.innerHTML = ''
})

describe('EmbeddingProfileSelect', () => {
  it('renders one rich selector with grouped cloud/local profiles and text-only mode', async () => {
    const wrapper = mountSelect()
    const trigger = wrapper.get('[data-testid="kb-index-model-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('索引模型: 自动')
    await trigger.trigger('click')
    await flushPromises()

    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect(listbox?.textContent).toContain('自动')
    expect(listbox?.textContent).toContain('云端模型')
    expect(listbox?.textContent).toContain('SiliconFlow')
    expect(listbox?.textContent).toContain('本地模型')
    expect(listbox?.textContent).toContain('Ollama')
    const downloadable = [
      ...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ].find((option) => option.textContent?.includes('mxbai-embed-large'))
    expect(downloadable?.getAttribute('aria-disabled')).toBe('true')
    expect(listbox?.textContent).toContain('仅文本检索')

    const footer = document.body.querySelector('[data-testid="kb-index-provider-notice"]')
    expect(footer).not.toBeNull()
    expect(listbox?.contains(footer)).toBe(false)
    expect(listbox?.getAttribute('aria-describedby')).toBe(footer?.id)
    expect(footer?.textContent).toContain('索引文本和查询文本会发送至该服务商')
    const link = footer?.querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.getAttribute('href')).toBe('https://hexclaw.net/zh/third-party-ai-services')
    expect(link?.getAttribute('aria-label')).toBe('查看第三方 AI 服务说明（在新窗口打开）')
  })

  it('supports Arrow/Home/End/Enter/Escape and restores focus to the trigger', async () => {
    const wrapper = mountSelect()
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="kb-index-model-trigger"]')
    trigger.element.focus()
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()

    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(trigger.attributes('aria-activedescendant')).toBeTruthy()

    await trigger.trigger('keydown', { key: 'End' })
    await trigger.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ kind: 'disabled' })
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'Home' })
    await trigger.trigger('keydown', { key: 'Escape' })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('accepts an assistive-technology click on a listbox option', async () => {
    const wrapper = mountSelect()
    await wrapper.get('[data-testid="kb-index-model-trigger"]').trigger('click')
    await flushPromises()

    const local = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('nomic-embed-text'),
    )
    expect(local).toBeTruthy()
    local?.click()
    await flushPromises()

    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({
      kind: 'profile',
      profile_id: 'local-nomic',
    })
  })

  it('keeps the provider documentation link keyboard reachable without a modal', async () => {
    const wrapper = mountSelect()
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="kb-index-model-trigger"]')
    await trigger.trigger('click')
    await flushPromises()
    await trigger.trigger('keydown', { key: 'Tab' })

    const link = document.body.querySelector<HTMLAnchorElement>(
      '[data-testid="kb-index-provider-docs"]',
    )
    expect(document.activeElement).toBe(link)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('closes the popover when tabbing forward past the documentation link', async () => {
    const wrapper = mountSelect()
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="kb-index-model-trigger"]')
    await trigger.trigger('click')
    await flushPromises()

    const link = document.body.querySelector<HTMLAnchorElement>(
      '[data-testid="kb-index-provider-docs"]',
    )
    expect(link).not.toBeNull()
    link?.focus()
    link?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    const nextControl = document.createElement('button')
    document.body.append(nextControl)
    nextControl.focus()
    await flushPromises()

    expect(trigger.attributes('aria-expanded')).toBe('false')
  })
})
