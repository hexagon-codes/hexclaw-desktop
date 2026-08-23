import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12AgentCard from '../views/K12AgentCard.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const DESKTOP_ROOT = path.resolve(__dirname, '../../../..')
const K12_CARD_SOURCE = readFileSync(
  path.join(DESKTOP_ROOT, 'src/features/k12/views/K12AgentCard.vue'),
  'utf8',
)
const AGENTS_VIEW_SOURCE = readFileSync(
  path.join(DESKTOP_ROOT, 'src/views/AgentsView.vue'),
  'utf8',
)
const AGENTS_CARD_FIXTURE_SOURCE = readFileSync(
  path.join(DESKTOP_ROOT, 'tests/e2e/browser-live-agents-card-layout.spec.ts'),
  'utf8',
)
const GLOBAL_CSS_SOURCE = readFileSync(
  path.join(DESKTOP_ROOT, 'src/assets/styles/global.css'),
  'utf8',
)

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('BUG-20260723-019 · K12 卡共享按钮与稳定身份事实', () => {
  it('共享按钮基础行高沿用原型 18px', () => {
    const base = GLOBAL_CSS_SOURCE.match(/\.btn,\s*\.hc-btn\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(base).toMatch(/line-height:\s*18px/)
  })

  it('K12 动作按钮使用共享 hc-btn 语义，事实槽从顶部开始排布', async () => {
    const wrapper = mount(K12AgentCard, {
      props: {
        agent: {
          name: 'k12-tutor-abc',
          display_name: '小明的辅导老师 · 五年级',
          metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明' },
        },
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    expect(wrapper.findAll('.k12ac__btn').map((button) => button.classes())).toEqual([
      expect.arrayContaining(['hc-btn', 'hc-btn-primary']),
      expect.arrayContaining(['hc-btn']),
      expect.arrayContaining(['hc-btn', 'hc-btn-ghost']),
    ])
    expect(K12_CARD_SOURCE).toMatch(
      /\.k12ac__chips\s*\{[^}]*align-content:\s*flex-start/s,
    )
    expect(K12_CARD_SOURCE).toMatch(
      /\.k12ac__actions\s*\{[^}]*align-items:\s*center/s,
    )
  })

  it('进入辅导按钮变体来自稳定 metadata，不按小孩顺序固定主按钮', async () => {
    const wrapper = mount(K12AgentCard, {
      props: {
        agent: {
          name: 'k12-tutor-hong',
          display_name: '小红的辅导助手 · 三年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小红',
            card_enter_variant: 'default',
          },
        },
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    const enterButton = wrapper.find('.k12ac__btn')
    expect(enterButton.classes()).toEqual(expect.arrayContaining(['hc-btn']))
    expect(enterButton.classes()).not.toContain('hc-btn-primary')

    const primaryWrapper = mount(K12AgentCard, {
      props: {
        agent: {
          name: 'k12-tutor-ming',
          display_name: '小明的辅导助手 · 五年级',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            card_enter_variant: 'primary',
          },
        },
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()
    expect(primaryWrapper.find('.k12ac__btn').classes()).toEqual(
      expect.arrayContaining(['hc-btn', 'hc-btn-primary']),
    )
  })

  it('图标事实来自稳定 metadata，不按卡片位置推断', () => {
    expect(AGENTS_VIEW_SOURCE).toMatch(
      /agent\.metadata\?\.(?:card_icon|\[['"]card_icon['"]\])/,
    )
    expect(AGENTS_VIEW_SOURCE).toMatch(/bar-chart/)
    expect(AGENTS_VIEW_SOURCE).toMatch(/mail/)
    expect(AGENTS_VIEW_SOURCE).not.toMatch(/v-for="\(\s*agent\s*,\s*(?:index|idx)\s*\)/)
    expect(AGENTS_CARD_FIXTURE_SOURCE).toMatch(
      /name: DIARY_AGENT,[\s\S]*?metadata:\s*\{[^}]*card_icon:\s*'bar-chart'/,
    )
    expect(AGENTS_CARD_FIXTURE_SOURCE).toMatch(
      /name: MAIL_AGENT,[\s\S]*?metadata:\s*\{[^}]*card_icon:\s*'mail'/,
    )
    expect(AGENTS_CARD_FIXTURE_SOURCE).toMatch(
      /name: K12_HONG_AGENT,[\s\S]*?card_enter_variant:\s*'default'/,
    )
  })
})
