import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChannelConfigModal from '../ChannelConfigModal.vue'
import zhCN from '@/i18n/locales/zh-CN'

// AUDIT 2026-06-23：账号/连接中心「新建通道」入口要支持 Telegram。
// Telegram 早已全链路就位（CHANNEL_TYPES + 配置字段 + logo + 后端 adapter/telegram + instances 工厂 +
// /connections/test 支持），唯独 ChannelConfigModal 把 telegram 从新建下拉里 filter 掉了（"暂不开放"）。
// 本测试钉死：新建第一步平台网格必须出现 Telegram 卡片。

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

describe('AUDIT 账号/连接中心新建通道支持 Telegram', () => {
  it('新建第一步平台网格出现 Telegram 卡片', () => {
    // 无 instance / presetType → 新建模式 step=1 选平台；模板用 Teleport to="body"，断言查 document.body
    mount(ChannelConfigModal, {
      props: { instance: null },
      global: { plugins: [i18n()] },
    })
    const names = Array.from(document.body.querySelectorAll('.hc-im-type-card__name')).map(
      (n) => n.textContent?.trim() ?? '',
    )
    expect(names.length).toBeGreaterThan(0) // 网格确实渲染了
    expect(names).toContain('Telegram')
  })

  it('新建第一步平台网格出现 微信公众号 + 企业微信 + Telegram（无类型被静默过滤）', () => {
    mount(ChannelConfigModal, { props: { instance: null }, global: { plugins: [i18n()] } })
    const names = Array.from(document.body.querySelectorAll('.hc-im-type-card__name')).map(
      (n) => n.textContent?.trim() ?? '',
    )
    for (const want of ['微信公众号', '企业微信', 'Telegram']) {
      expect(names, `创建入口应包含「${want}」，实际=${names.join('/')}`).toContain(want)
    }
  })
})
