import { describe, it, expect, vi } from 'vitest'
import k12EnhSrc from '../views/K12ChatEnhancement.vue?raw'
import chatViewSrc from '@/views/ChatView.vue?raw'
import recordsSrc from '../views/K12RecordsView.vue?raw'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

// BUG-20260712 桌面 K12 三处 UI bug 闭环：
//  #1 拍照识题选图后把 base64 原文糊在框里（应显缩略图预览）
//  #2 识题面板题目多时撑出视口：它必须进入消息流并复用消息区的唯一滚动容器，不能再套第二层滚动。
//  #3 频道「绑定会话」添加行布局 bug —— 该 per-chat 会话路由功能经产品评审（方案 A）已彻底移除，
//     原 CSS 断言随功能删除而废止；防复活回归锁见 channels/__tests__/removal-chat-route-session-routing.test.ts

vi.mock('@/api/k12', () => ({
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
}))

function render() {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
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

describe('BUG-20260712 #2 识题面板复用消息区滚动（题目多不撑出视口）', () => {
  it('面板落在消息内联槽，自身不建立第二个滚动容器，滚动终点位于面板之后', () => {
    const tutorRule = k12EnhSrc.match(/\.k12enh-tutor\s*\{[^}]*\}/)?.[0] ?? ''
    expect(k12EnhSrc).toContain(':to="`#${scenarioMessageAnchorId(task.sourceMessageId)}`"')
    expect(tutorRule).not.toMatch(/max-height\s*:/)
    expect(tutorRule).not.toMatch(/overflow-y\s*:/)
    expect(chatViewSrc).toMatch(
      /:id="scenarioMessageAnchorId\(msg\.id\)"[\s\S]*ref="messagesEndRef"/,
    )
    expect(chatViewSrc).toMatch(/v-if="[^"]*scenarioInlineActive[^"]*"\s+ref="messagesEndRef"/)
    expect(chatViewSrc).toContain('@update:inline-active="handleScenarioInlineActive"')
    expect(chatViewSrc).toMatch(
      /chatStore\.messages\.length === 0[\s\S]{0,160}!scenarioInlineActive/,
    )
  })
})

describe('BUG-20260724-001 K12 场景消息与普通助手消息共用水平轨道', () => {
  it('内联锚点不居中限宽，场景消息不再叠加水平 margin', () => {
    const inlineRule =
      chatViewSrc.match(/\.hc-chat__scenario-inline\s*\{[^}]*\}/)?.[0] ?? ''
    const tutorRule = k12EnhSrc.match(/\.k12enh-tutor\s*\{[^}]*\}/)?.[0] ?? ''

    expect(inlineRule).toMatch(/width\s*:\s*100%/)
    expect(inlineRule).toMatch(/max-width\s*:\s*none/)
    expect(inlineRule).toMatch(/margin\s*:\s*0\s*;/)
    expect(tutorRule).toMatch(/gap\s*:\s*10px/)
    expect(tutorRule).toMatch(/margin\s*:\s*0 0 8px\s*;/)
  })
})

// BUG-20260712 #3（频道「绑定会话」添加行布局）已随 per-chat 会话路由功能整体移除（方案 A）——
// 断言删除，改由 channels/__tests__/removal-chat-route-session-routing.test.ts 防止复活。

describe('BUG-20260712 #7 验算并计入 60-120s 有进度反馈', () => {
  it('保存中按钮切换为「验算中…」文案（原恒显「验算并记入」像卡死）', () => {
    expect(recordsSrc).toMatch(/mistakeSaving\s*\?\s*t\('k12\.mistakeAdd\.submitting'\)/) // RED：无切换
  })
})
