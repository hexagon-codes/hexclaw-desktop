/**
 * SOUL 结构化编辑器纯逻辑（原型 C 方案落地桌面）：
 * 7 自由段（身份/目标/上下文/决策/约束/输出/自检）+ 三预设 + 合成 + 体检打分。
 * 合成产物是写回 system_prompt 的 markdown——顺序与段名是与原型对齐的稳定契约。
 */
import { describe, it, expect } from 'vitest'
import {
  SOUL_SEGMENTS,
  SOUL_PRESETS,
  presetState,
  seedFromText,
  assembleSoul,
  soulHealth,
} from '@/utils/soul-editor'

describe('soul-editor 段定义与预设', () => {
  it('7 个自由段按稳定顺序定义（与原型/后端注入顺序对齐）', () => {
    expect(SOUL_SEGMENTS.map((s) => s.key)).toEqual([
      'identity', 'mission', 'context', 'decision', 'constraints', 'output', 'eval',
    ])
  })

  it('三预设：空白=全关；极简=身份/目标/约束；完整=7 段全开', () => {
    expect(Object.keys(SOUL_PRESETS)).toEqual(['blank', 'lite', 'full'])
    const blank = presetState('blank')
    expect(Object.values(blank).every((s) => !s.on)).toBe(true)
    const lite = presetState('lite')
    expect(Object.entries(lite).filter(([, s]) => s.on).map(([k]) => k)).toEqual([
      'identity', 'mission', 'constraints',
    ])
    const full = presetState('full')
    expect(Object.values(full).every((s) => s.on)).toBe(true)
    // 预设开启的段带示例文本（可一键起草）
    expect(full.identity!.val.length).toBeGreaterThan(0)
  })

  it('seedFromText：已有人设文本落入 identity 段（完整预设为底）', () => {
    const st = seedFromText('你是专业翻译官。')
    expect(st.identity!.val).toBe('你是专业翻译官。')
    expect(st.mission!.on).toBe(true) // full 预设为底
  })
})

describe('assembleSoul 合成', () => {
  it('只合成开启且非空的段，按定义顺序输出 markdown 小节', () => {
    const st = presetState('blank')
    st.constraints = { on: true, val: '不编造' }
    st.identity = { on: true, val: '你是小蟹' }
    st.mission = { on: false, val: '不该出现' }
    const out = assembleSoul(st)
    expect(out).toBe('## 身份（Identity）\n你是小蟹\n\n## 约束（Constraints）\n不编造')
  })

  it('全空 → 合成空串（调用方据此不覆盖原文本）', () => {
    expect(assembleSoul(presetState('blank'))).toBe('')
  })
})

describe('soulHealth 体检', () => {
  it('完整预设（全段示例）≥80 分且无缺段提示', () => {
    const { score, tips } = soulHealth(presetState('full'))
    expect(score).toBeGreaterThanOrEqual(80)
    expect(tips.some((t) => t.level === 'miss')).toBe(false)
  })

  it('空白 → 低分且逐段给缺失提示', () => {
    const { score, tips } = soulHealth(presetState('blank'))
    expect(score).toBeLessThan(50)
    expect(tips.filter((t) => t.level === 'miss').length).toBe(SOUL_SEGMENTS.length)
  })

  it('偏短内容给 warn 提示（半分），不按缺失计', () => {
    const st = presetState('blank')
    st.identity = { on: true, val: '短' } // <12 字
    const { tips } = soulHealth(st)
    expect(tips.some((t) => t.level === 'warn' && t.text.includes('身份'))).toBe(true)
  })
})
