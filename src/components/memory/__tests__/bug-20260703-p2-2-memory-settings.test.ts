/**
 * BUG-20260703 P2-2 — 记忆设置 + 用户画像桌面暴露面。
 *
 * 此前 config.FileMemory 的 auto_memory/recall_min_score/active_recall/profile 只能
 * 手改 yaml，画像蒸馏产物埋在记忆列表里无专门展示。本组件接 GET/PUT
 * /api/v1/config/memory（后端锁 bug_20260703_p2_2_memory_config_test.go）+
 * source=reflect_profile 画像卡；MemoryView 挂载（可达链断开即 FAIL）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MemorySettingsPanel from '../MemorySettingsPanel.vue'
import zhCN from '@/i18n/locales/zh-CN'

const api = vi.hoisted(() => ({
  getMemoryConfig: vi.fn(),
  updateMemoryConfig: vi.fn(),
  getMemoryEntries: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/memory', () => ({ ...api }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const DEFAULT_CFG = {
  enabled: true,
  auto_memory: 'inline',
  recall_min_score: 0.3,
  active_recall: true,
  profile: true,
  profile_interval_mins: 1440,
}

function mountPanel() {
  return mount(MemorySettingsPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
    },
  })
}

describe('BUG-20260703 P2-2 — 记忆行为设置面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getMemoryConfig.mockResolvedValue({ ...DEFAULT_CFG })
    api.updateMemoryConfig.mockImplementation(async (patch: Record<string, unknown>) => ({
      status: 'ok',
      config: { ...DEFAULT_CFG, ...patch },
      restart_required: [],
    }))
    api.getMemoryEntries.mockResolvedValue({ entries: [], summary: '', capacity: { used: 0, max: 200 } })
  })

  it('展开后按后端配置渲染：inline 选中、地板值、两开关状态', async () => {
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="memset-toggle"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="memset-automemory-inline"]').attributes('aria-checked')).toBe('true')
    expect((w.find('[data-testid="memset-recall-floor"]').element as HTMLInputElement).value).toBe('0.3')
    expect((w.find('[data-testid="memset-active-recall"]').element as HTMLInputElement).checked).toBe(true)
    expect((w.find('[data-testid="memset-profile"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('切 auto_memory 到 extract → PUT 字段级 patch + 服务端回包落 UI', async () => {
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="memset-toggle"]').trigger('click')
    await w.find('[data-testid="memset-automemory-extract"]').trigger('click')
    await flushPromises()

    expect(api.updateMemoryConfig).toHaveBeenCalledWith({ auto_memory: 'extract' })
    expect(w.find('[data-testid="memset-automemory-extract"]').attributes('aria-checked')).toBe('true')
    expect(toast.success).toHaveBeenCalled()
  })

  it('关闭画像蒸馏（restart_required）→ 显示重启提示', async () => {
    api.updateMemoryConfig.mockResolvedValue({
      status: 'ok',
      config: { ...DEFAULT_CFG, profile: false },
      restart_required: ['profile'],
    })
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="memset-toggle"]').trigger('click')
    await w.find('[data-testid="memset-profile"]').trigger('change')
    await flushPromises()

    expect(api.updateMemoryConfig).toHaveBeenCalledWith({ profile: false })
    expect(w.find('[data-testid="memset-restart-hint"]').exists()).toBe(true)
  })

  it('保存失败 → 乐观值回滚 + toast 报错（不静默吞错）', async () => {
    api.updateMemoryConfig.mockRejectedValue(new Error('boom-save'))
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="memset-toggle"]').trigger('click')
    await w.find('[data-testid="memset-automemory-off"]').trigger('click')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('boom-save')
    expect(w.find('[data-testid="memset-automemory-inline"]').attributes('aria-checked')).toBe('true')
    expect(w.find('[data-testid="memset-automemory-off"]').attributes('aria-checked')).toBe('false')
  })

  it('配置接口不可用 → 展开显示不可用态，不崩', async () => {
    api.getMemoryConfig.mockRejectedValue(new Error('engine down'))
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="memset-toggle"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('记忆设置不可用')
  })
})

describe('BUG-20260703 P2-2 — 用户画像卡', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getMemoryConfig.mockResolvedValue({ ...DEFAULT_CFG })
  })

  it('有 reflect_profile 活跃条 → 渲染画像卡（内容 + 蒸馏来源说明）', async () => {
    api.getMemoryEntries.mockResolvedValue({
      entries: [{
        id: 'p1', content: '常驻乌鲁木齐的工程师，偏好中文交互。', type: 'identity',
        source: 'reflect_profile', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
        hit_count: 0, status: 'active', pinned: true, subject: '用户画像',
      }],
      summary: '', capacity: { used: 1, max: 200 },
    })
    const w = mountPanel()
    await flushPromises()

    expect(api.getMemoryEntries).toHaveBeenCalledWith(expect.objectContaining({ source: 'reflect_profile' }))
    const card = w.find('[data-testid="memory-profile-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('常驻乌鲁木齐的工程师')
    expect(card.text()).toContain('用户画像')
  })

  it('无画像条 → 不渲染画像卡（不占位）', async () => {
    api.getMemoryEntries.mockResolvedValue({ entries: [], summary: '', capacity: { used: 0, max: 200 } })
    const w = mountPanel()
    await flushPromises()
    expect(w.find('[data-testid="memory-profile-card"]').exists()).toBe(false)
  })

  it('归档画像条不当活跃画像展示', async () => {
    api.getMemoryEntries.mockResolvedValue({
      entries: [{
        id: 'p0', content: '旧画像', type: 'identity', source: 'reflect_profile',
        created_at: '', updated_at: '', hit_count: 0, status: 'archived',
      }],
      summary: '', capacity: { used: 1, max: 200 },
    })
    const w = mountPanel()
    await flushPromises()
    expect(w.find('[data-testid="memory-profile-card"]').exists()).toBe(false)
  })
})

describe('BUG-20260703 P2-2 — 可达链', () => {
  it('MemoryView 挂载 MemorySettingsPanel（暴露面进记忆页）', () => {
    const src = readFileSync(resolve(__dirname, '../../../views/MemoryView.vue'), 'utf8')
    expect(src).toContain("import MemorySettingsPanel from '@/components/memory/MemorySettingsPanel.vue'")
    expect(src).toContain('<MemorySettingsPanel')
  })
})
