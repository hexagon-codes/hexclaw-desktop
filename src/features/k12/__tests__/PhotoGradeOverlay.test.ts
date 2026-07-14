import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PhotoGradeOverlay from '../views/PhotoGradeOverlay.vue'
import type { BBox } from '@/api/k12'

// 原图批改 Phase 1（对标作业帮/小猿）：确定性叠加 ✓/✗，bbox 错位比不标更糟。
// 钉死：①合法 bbox → 按坐标画 ✓（绿）/✗（红）②缺失 bbox → 不叠加、降级文字批改
// ③非法 bbox（越界/零框）→ 不渲染（错位防护）④叠加层可开关。
function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

interface Mark {
  correct: boolean
  outOfScope?: boolean
  bbox?: BBox | null
  question?: string
  correctAnswer?: string
  errorCause?: string
}
function render(marks: Mark[], image = 'data:image/png;base64,AAAA') {
  return mount(PhotoGradeOverlay, {
    props: { image, marks },
    global: { plugins: [i18n()] },
  })
}

describe('PhotoGradeOverlay（原图批改 Phase 1 · 确定性叠加 + bbox 错位防护）', () => {
  it('①合法 bbox：对题画绿 ✓、错题画红 ✗，并按归一化坐标定位', async () => {
    const w = render([
      { correct: true, bbox: { x: 0.1, y: 0.2, w: 0.15, h: 0.05 }, question: '3.8×3=?' },
      { correct: false, bbox: { x: 0.3, y: 0.5, w: 0.2, h: 0.06 }, question: '25×4', correctAnswer: '100', errorCause: '进位错误' },
    ])
    const m0 = w.find('[data-testid="overlay-mark-0"]')
    const m1 = w.find('[data-testid="overlay-mark-1"]')
    expect(m0.exists()).toBe(true)
    expect(m1.exists()).toBe(true)
    // 对/错符号
    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✓')
    expect(w.find('[data-testid="overlay-sym-1"]').text()).toBe('✗')
    // 对绿/错红（类名区分）
    expect(m0.classes()).toContain('pg-overlay__mark--correct')
    expect(m1.classes()).toContain('pg-overlay__mark--wrong')
    // 归一化坐标 → 百分比定位（x*100% / y*100% / w*100% / h*100%）
    expect(m0.attributes('style')).toContain('left: 10%')
    expect(m0.attributes('style')).toContain('top: 20%')
    expect(m0.attributes('style')).toContain('width: 15%')
    expect(m1.attributes('style')).toContain('left: 30%')
    // 错题订正贴框旁
    expect(w.find('[data-testid="overlay-fix-1"]').text()).toBe('100')
    // 无降级项
    expect(w.find('[data-testid="overlay-degraded"]').exists()).toBe(false)
  })

  it('②bbox 缺失：不叠加定位标记，降级为文字批改', async () => {
    const w = render([
      { correct: false, bbox: null, question: '看图说话', correctAnswer: '参考答案', errorCause: '离题' },
    ])
    // 不画错位红叉
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    // 降级文字批改出现，且含题干/订正/错因
    const deg = w.find('[data-testid="overlay-degraded-0"]')
    expect(deg.exists()).toBe(true)
    expect(deg.text()).toContain('看图说话')
    expect(deg.text()).toContain('参考答案')
    expect(deg.text()).toContain('离题')
  })

  it('③非法 bbox（错位防护）：越界/零框/负值一律不渲染，改走降级', async () => {
    const illegal: (BBox)[] = [
      { x: 0.9, y: 0.1, w: 0.5, h: 0.1 }, // 右越界
      { x: 0.1, y: 0.1, w: 0, h: 0 }, // 零框
      { x: -0.1, y: 0.1, w: 0.2, h: 0.1 }, // 负坐标
      { x: 1.5, y: 0.1, w: 0.1, h: 0.1 }, // 坐标越界
    ]
    const w = render(illegal.map((bbox, i) => ({ correct: true, bbox, question: `q${i}` })))
    // 无一渲染为定位标记
    for (let i = 0; i < illegal.length; i++) {
      expect(w.find(`[data-testid="overlay-mark-${i}"]`).exists(), `非法 bbox[${i}] 不得叠加`).toBe(false)
      expect(w.find(`[data-testid="overlay-degraded-${i}"]`).exists()).toBe(true)
    }
  })

  it('④叠加层可开关：点切换后隐藏定位标记（看原图）', async () => {
    const w = render([{ correct: true, bbox: { x: 0.1, y: 0.2, w: 0.15, h: 0.05 }, question: 'q' }])
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(true)
    await w.find('[data-testid="overlay-toggle"]').trigger('click')
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    // 原图仍在
    expect(w.find('[data-testid="overlay-image"]').exists()).toBe(true)
    // 再点切回
    await w.find('[data-testid="overlay-toggle"]').trigger('click')
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(true)
  })

  it('超出学习范围不是答错：即使有 bbox 也不画红叉，降级显示范围提示', () => {
    const w = render([
      { correct: false, outOfScope: true, bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 }, question: '超纲题' },
    ])
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    const degraded = w.find('[data-testid="overlay-degraded-0"]')
    expect(degraded.exists()).toBe(true)
    expect(degraded.text()).toContain('超出当前范围')
    expect(degraded.text()).not.toContain('答错')
  })

  it('原图始终为底（确定性绘制，非 AI 生成图）', () => {
    const w = render([{ correct: true, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.05 } }], 'data:image/png;base64,ZZZ')
    expect(w.find('[data-testid="overlay-image"]').attributes('src')).toBe('data:image/png;base64,ZZZ')
  })

  it('提供保存批改图按钮，不能只有临时 DOM 叠层', () => {
    const w = render([{ correct: true, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.05 } }])
    expect(w.find('[data-testid="overlay-save"]').exists()).toBe(true)
  })
})
