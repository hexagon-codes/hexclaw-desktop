/**
 * BUG-20260712-B1（嵌入模型开箱保证 · 前端可见化 + 一键激活）：
 * 真机取证——Ollama 只装了 qwen3.5:9b，auto-config 选定的 nomic-embed-text 从未安装，
 * 知识库自动注入常年休眠且**用户无从得知**（隐形悬崖）。
 *
 * 契约（三态机制 · 20260712 产品评审定案）：后端首启**后台静默自动安装**（batteries-included，
 * 对标 Apple 本地模型/Cursor 索引），本横幅是**异常驱动披露**：
 *  ① pulling=true（静默安装中）→ 零打扰不渲染，仅轮询；
 *  ② ready=false 且非 pulling（自动安装失败：离线/被墙/已禁用）→ 才渲染横幅 + 手动安装（SSE 进度）；
 *  ③ 安装完成 → 重查 → ready=true → 横幅消失（装完即活，无需重启）；
 *  ④ ready=true / 未配置 / 云端 provider / 旧引擎 → 不渲染。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { statusMock, pullMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  pullMock: vi.fn(),
}))
vi.mock('@/api/knowledge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getKnowledgeEmbeddingStatus: (...a: unknown[]) => statusMock(...a),
}))
vi.mock('@/api/ollama', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pullOllamaModel: (...a: unknown[]) => pullMock(...a),
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import EmbeddingStatusBanner from '../EmbeddingStatusBanner.vue'

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
function mountBanner() {
  return mount(EmbeddingStatusBanner, { global: { plugins: [i18n()] } })
}

describe('BUG-20260712-B1：嵌入状态横幅（休眠可见化 + 一键激活）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('★本地未装嵌入模型 → 渲染休眠横幅 + 一键安装按钮（隐形悬崖可见化）', async () => {
    statusMock.mockResolvedValue({ enabled: true, configured: true, provider: 'ollama', model: 'nomic-embed-text', local: true, ready: false, pulling: false })
    const w = mountBanner()
    await flushPromises()
    expect(w.find('[data-testid="embedding-banner"]').exists()).toBe(true)
    expect(w.text()).toContain('语义检索未激活')
    expect(w.find('[data-testid="embedding-install"]').exists()).toBe(true)
    expect(pullMock, '绝不自动静默下载').not.toHaveBeenCalled()
  })

  it('★点击一键安装 → pull 选定模型（SSE 进度）→ 完成后重查状态 → ready 即横幅消失', async () => {
    statusMock
      .mockResolvedValueOnce({ enabled: true, configured: true, provider: 'ollama', model: 'nomic-embed-text', local: true, ready: false, pulling: false })
      .mockResolvedValueOnce({ enabled: true, configured: true, provider: 'ollama', model: 'nomic-embed-text', local: true, ready: true, pulling: false })
    pullMock.mockImplementation(async (_m: string, onProgress: (p: { status: string; completed?: number; total?: number }) => void) => {
      onProgress({ status: 'pulling', completed: 137, total: 274 })
    })
    const w = mountBanner()
    await flushPromises()
    await w.find('[data-testid="embedding-install"]').trigger('click')
    await flushPromises()

    expect(pullMock).toHaveBeenCalledWith('nomic-embed-text', expect.any(Function), undefined)
    expect(statusMock).toHaveBeenCalledTimes(2) // 装完重查
    expect(w.find('[data-testid="embedding-banner"]').exists(), '装完即活，横幅消失').toBe(false)
  })

  it('ready=true / 未配置 → 不渲染（不打扰）', async () => {
    statusMock.mockResolvedValue({ enabled: true, configured: true, provider: 'ollama', model: 'nomic-embed-text', local: true, ready: true, pulling: false })
    const ok = mountBanner()
    await flushPromises()
    expect(ok.find('[data-testid="embedding-banner"]').exists()).toBe(false)

    statusMock.mockResolvedValue({ enabled: false, configured: false, local: false, ready: false, pulling: false })
    const off = mountBanner()
    await flushPromises()
    expect(off.find('[data-testid="embedding-banner"]').exists(), 'KB 未启用不渲染').toBe(false)
  })

  it('★静默安装进行中（pulling=true）→ 零打扰不渲染（三态机制：成功路径用户零感知）', async () => {
    statusMock.mockResolvedValue({ enabled: true, configured: true, provider: 'ollama', model: 'nomic-embed-text', local: true, ready: false, pulling: true })
    const w = mountBanner()
    await flushPromises()
    expect(w.find('[data-testid="embedding-banner"]').exists(), '安装中不得打扰用户').toBe(false)
    expect(pullMock).not.toHaveBeenCalled()
  })

  it('状态接口失败（旧引擎无该端点）→ 静默不渲染（向后兼容）', async () => {
    statusMock.mockRejectedValue(new Error('404'))
    const w = mountBanner()
    await flushPromises()
    expect(w.find('[data-testid="embedding-banner"]').exists()).toBe(false)
  })
})
