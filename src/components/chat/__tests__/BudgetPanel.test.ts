import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import BudgetPanel from '../BudgetPanel.vue'

// lucide-vue-next icons are stubbed to simple <span/> elements
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
  maxTokens?: number
  usedTokens?: number
  maxDuration?: string
  elapsedSeconds?: number
  maxCost?: number
  usedCost?: number
}

function mountPanel(overrides: MountOptions = {}) {
  return mount(BudgetPanel, {
    props: {
      maxTokens: overrides.maxTokens ?? 100000,
      usedTokens: overrides.usedTokens ?? 0,
      maxDuration: overrides.maxDuration ?? '30m',
      elapsedSeconds: overrides.elapsedSeconds ?? 0,
      maxCost: overrides.maxCost ?? 5.0,
      usedCost: overrides.usedCost ?? 0,
    },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

/** Helper: extract width % from the Nth fill bar (0=tokens, 1=time, 2=cost) */
function fillWidth(wrapper: ReturnType<typeof mount>, index: number): string {
  const fills = wrapper.findAll('.budget-panel__fill')
  return fills[index]?.attributes('style') ?? ''
}

/** Helper: extract the background color from the Nth fill bar */
function fillColor(wrapper: ReturnType<typeof mount>, index: number): string {
  const style = fillWidth(wrapper, index)
  const match = style.match(/background:\s*([^;]+)/)
  return match?.[1]?.trim() ?? ''
}

describe('BudgetPanel', () => {
  it('renders 3 budget rows (tokens, time, cost)', () => {
    const wrapper = mountPanel()
    const rows = wrapper.findAll('.budget-panel__row')
    expect(rows).toHaveLength(3)
    expect(wrapper.text()).toContain('Tokens')
    expect(wrapper.text()).toContain('Time')
    expect(wrapper.text()).toContain('Cost')
  })

  it('token bar at 50% width with primary color', () => {
    const wrapper = mountPanel({ maxTokens: 1000, usedTokens: 500 })
    expect(fillWidth(wrapper, 0)).toContain('width: 50%')
    expect(fillColor(wrapper, 0)).toContain('--hc-primary')
  })

  it('token bar at 90% shows error color', () => {
    const wrapper = mountPanel({ maxTokens: 1000, usedTokens: 900 })
    expect(fillWidth(wrapper, 0)).toContain('width: 90%')
    expect(fillColor(wrapper, 0)).toContain('--hc-error')
  })

  it('token bar at 70% shows warning color', () => {
    const wrapper = mountPanel({ maxTokens: 1000, usedTokens: 700 })
    expect(fillWidth(wrapper, 0)).toContain('width: 70%')
    expect(fillColor(wrapper, 0)).toContain('--hc-warning')
  })

  it('division by zero: maxTokens=0 shows 0% bar', () => {
    const wrapper = mountPanel({ maxTokens: 0, usedTokens: 100 })
    expect(fillWidth(wrapper, 0)).toContain('width: 0%')
  })

  it('division by zero: maxCost=0 shows 0% bar', () => {
    const wrapper = mountPanel({ maxCost: 0, usedCost: 1.5 })
    expect(fillWidth(wrapper, 2)).toContain('width: 0%')
  })

  it('formatTokens: 500 → "500", 1500 → "2K", 1000000 → "1.0M"', () => {
    const w1 = mountPanel({ maxTokens: 500, usedTokens: 500 })
    expect(w1.text()).toContain('500/500')

    const w2 = mountPanel({ maxTokens: 2000, usedTokens: 1500 })
    expect(w2.text()).toContain('2K')

    const w3 = mountPanel({ maxTokens: 1000000, usedTokens: 1000000 })
    expect(w3.text()).toContain('1.0M')
  })

  it('formatDuration: 30 → "30s", 90 → "1m30s", 0 → "0s"', () => {
    const w1 = mountPanel({ elapsedSeconds: 30 })
    expect(w1.text()).toContain('30s')

    const w2 = mountPanel({ elapsedSeconds: 90 })
    expect(w2.text()).toContain('1m30s')

    const w3 = mountPanel({ elapsedSeconds: 0 })
    expect(w3.text()).toContain('0s')
  })

  it('maxDuration parsing: "30m" → 1800s, "60m" → 3600s', () => {
    // At 900s elapsed with 30m max, that's 50%
    const w1 = mountPanel({ maxDuration: '30m', elapsedSeconds: 900 })
    expect(fillWidth(w1, 1)).toContain('width: 50%')

    // At 1800s elapsed with 60m max, that's also 50%
    const w2 = mountPanel({ maxDuration: '60m', elapsedSeconds: 1800 })
    expect(fillWidth(w2, 1)).toContain('width: 50%')
  })

  it('maxDuration fallback: invalid format → 1800s', () => {
    // 900s out of fallback 1800s = 50%
    const wrapper = mountPanel({ maxDuration: 'invalid', elapsedSeconds: 900 })
    expect(fillWidth(wrapper, 1)).toContain('width: 50%')
  })

  it('cost display formats to 2 decimal places', () => {
    const wrapper = mountPanel({ maxCost: 10, usedCost: 3.1 })
    expect(wrapper.text()).toContain('$3.10')
    expect(wrapper.text()).toContain('$10.00')
  })

  it('progress bars capped at 100% even when usage exceeds max', () => {
    const wrapper = mountPanel({
      maxTokens: 100,
      usedTokens: 200,
      maxDuration: '1m',
      elapsedSeconds: 120,
      maxCost: 1,
      usedCost: 5,
    })
    expect(fillWidth(wrapper, 0)).toContain('width: 100%')
    expect(fillWidth(wrapper, 1)).toContain('width: 100%')
    expect(fillWidth(wrapper, 2)).toContain('width: 100%')
  })
})
