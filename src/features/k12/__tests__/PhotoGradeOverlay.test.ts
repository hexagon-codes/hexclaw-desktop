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
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
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
  it('权威原型：结果以整页摘要 + 原图主体 + 右侧仅展开需关注题呈现', () => {
    const w = render([
      { correct: true, bbox: { x: 0.1, y: 0.2, w: 0.15, h: 0.05 }, question: '第 1 题' },
      {
        correct: false,
        bbox: { x: 0.3, y: 0.5, w: 0.2, h: 0.06 },
        question: '第 2 题',
        correctAnswer: '100',
        errorCause: '进位错误',
      },
    ])

    expect(w.get('[data-testid="photo-grade-overlay"]').classes()).toContain('grade-result')
    const stats = w.findAll('.grade-stat b').map((item) => item.text())
    expect(stats).toEqual(['2', '1', '1', '0'])
    expect(w.get('.grade-media__bar').text()).toContain('作业原图 · 未经任何修改')
    expect(w.get('.grade-analysis__head').text()).toContain('只展开需要关注的题')
    expect(w.findAll('.grade-analysis .grade-card--issue')).toHaveLength(1)
    expect(w.get('.grade-card--issue').attributes('open')).toBeDefined()
    expect(w.get('.grade-card--correct').attributes('open')).toBeUndefined()
    expect(w.findAll('.grade-legend [data-grade-status]')).toHaveLength(8)
  })

  it('①合法 bbox：对题画绿 ✓、错题画红 ✗，并按归一化坐标定位', async () => {
    const w = render([
      { correct: true, bbox: { x: 0.1, y: 0.2, w: 0.15, h: 0.05 }, question: '3.8×3=?' },
      {
        correct: false,
        bbox: { x: 0.3, y: 0.5, w: 0.2, h: 0.06 },
        question: '25×4',
        correctAnswer: '100',
        errorCause: '进位错误',
      },
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
    // bbox 是精确答案框；符号放在答案右侧并略向下居中，不再画覆盖答案的大矩形。
    expect(m0.attributes('style')).toContain('left: 25%')
    expect(m0.attributes('style')).toContain('top: 22%')
    expect(m0.attributes('style')).not.toContain('width:')
    expect(m1.attributes('style')).toContain('left: 50%')
    // 原图只承载紧凑勾叉，订正与错因留在文字讲评区。
    expect(w.find('[data-testid="overlay-fix-1"]').exists()).toBe(false)
    // 无降级项
    expect(w.find('[data-testid="overlay-degraded"]').exists()).toBe(false)
  })

  it('②bbox 缺失：不叠加定位标记，降级为文字批改', async () => {
    const w = render([
      {
        correct: false,
        bbox: null,
        question: '看图说话',
        correctAnswer: '参考答案',
        errorCause: '离题',
      },
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
    const illegal: BBox[] = [
      { x: 0.9, y: 0.1, w: 0.5, h: 0.1 }, // 右越界
      { x: 0.1, y: 0.1, w: 0, h: 0 }, // 零框
      { x: -0.1, y: 0.1, w: 0.2, h: 0.1 }, // 负坐标
      { x: 1.5, y: 0.1, w: 0.1, h: 0.1 }, // 坐标越界
    ]
    const w = render(illegal.map((bbox, i) => ({ correct: true, bbox, question: `q${i}` })))
    // 无一渲染为定位标记
    for (let i = 0; i < illegal.length; i++) {
      expect(w.find(`[data-testid="overlay-mark-${i}"]`).exists(), `非法 bbox[${i}] 不得叠加`).toBe(
        false,
      )
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
      {
        correct: false,
        outOfScope: true,
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
        question: '超纲题',
      },
    ])
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    const degraded = w.find('[data-testid="overlay-degraded-0"]')
    expect(degraded.exists()).toBe(true)
    expect(degraded.text()).toContain('超出当前范围')
    expect(degraded.text()).not.toContain('答错')
  })

  it('原图始终为底（确定性绘制，非 AI 生成图）', () => {
    const w = render(
      [{ correct: true, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.05 } }],
      'data:image/png;base64,ZZZ',
    )
    expect(w.find('[data-testid="overlay-image"]').attributes('src')).toBe(
      'data:image/png;base64,ZZZ',
    )
  })

  it('不混入权威原型外的保存批改图入口', () => {
    const w = render([{ correct: true, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.05 } }])
    expect(w.find('[data-testid="overlay-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="overlay-save"]').exists()).toBe(false)
  })
})
