import { describe, it, expect, vi } from 'vitest'
import k12EnhSrc from '../views/K12ChatEnhancement.vue?raw'
import channelBindSrc from '@/components/channels/ChannelAgentBinding.vue?raw'
import recordsSrc from '../views/K12RecordsView.vue?raw'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

// BUG-20260712 桌面 K12 三处 UI bug 闭环：
//  #1 拍照识题选图后把 base64 原文糊在框里（应显缩略图预览）
//  #2 识题面板题目多时撑出视口且不能滚（.k12enh-tutor 缺 max-height+overflow-y）
//  #3 频道「绑定会话」添加行在窄卡片里布局错乱（下拉无 flex 压扁输入框）——见 channels 侧测试

vi.mock('@/api/k12', () => ({
  k12Recognize: vi.fn().mockResolvedValue({ questions: [] }),
  k12Grade: vi.fn(), k12ColdStart: vi.fn(), k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(), k12ProvisionCron: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12PrepCard: vi.fn(), k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(), k12ListAccumulation: vi.fn(),
}))

function render() {
  const i18n = createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
  return mount(RecognizeGuardPanel, {
    props: { agentId: 'mingming', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n] },
  })
}

describe('BUG-20260712 #1 拍照识题选图显缩略图，不糊 base64 原文', () => {
  it('设了图片 data URL → 出现缩略图预览 + base64 textarea 隐藏', async () => {
    const w = render()
    await w.find('[data-testid=recognize-b64]').setValue('data:image/png;base64,AAAABBBB')
    const preview = w.find('[data-testid=recognize-preview]')
    expect(preview.exists()).toBe(true) // RED（修前）：无缩略图 → false
    expect(preview.attributes('src')).toBe('data:image/png;base64,AAAABBBB')
    // 原始 base64 textarea 不再可见（v-show=false → display:none）
    const ta = w.find('[data-testid=recognize-b64]')
    expect((ta.element as HTMLElement).style.display).toBe('none')
  })

  it('未选图（空）→ 显示 textarea 供粘贴回退，无缩略图', () => {
    const w = render()
    expect(w.find('[data-testid=recognize-preview]').exists()).toBe(false)
    const ta = w.find('[data-testid=recognize-b64]')
    expect((ta.element as HTMLElement).style.display).not.toBe('none')
  })
})

describe('BUG-20260712 #2 识题面板可滚动（题目多不撑出视口）', () => {
  it('.k12enh-tutor 有 max-height + overflow-y 滚动兜底', () => {
    // 断言 .k12enh-tutor 规则块内同时含 max-height 与 overflow-y:auto（[^}]* 限定在规则内）
    expect(k12EnhSrc).toMatch(/\.k12enh-tutor\s*\{[^}]*max-height:[^}]*\}/)         // RED（修前）：无 max-height
    expect(k12EnhSrc).toMatch(/\.k12enh-tutor\s*\{[^}]*overflow-y:\s*auto[^}]*\}/)  // RED（修前）：无 overflow-y
  })
})

describe('BUG-20260712 #3 绑定会话添加行窄卡片不再挤压错乱', () => {
  it('route-add 换行 + route-select 有 flex（原下拉无 flex 压扁输入框）', () => {
    expect(channelBindSrc).toMatch(/\.hc-cab__route-add\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}/) // RED：无 flex-wrap
    expect(channelBindSrc).toMatch(/\.hc-cab__route-select\s*\{[^}]*flex:/)                 // RED：route-select 无 CSS/flex
  })
})

describe('BUG-20260712 #7 验算并计入 60-120s 有进度反馈', () => {
  it('保存中按钮切换为「验算中…」文案（原恒显「验算并记入」像卡死）', () => {
    expect(recordsSrc).toMatch(/mistakeSaving\s*\?\s*t\('k12\.mistakeAdd\.submitting'\)/) // RED：无切换
  })
})
