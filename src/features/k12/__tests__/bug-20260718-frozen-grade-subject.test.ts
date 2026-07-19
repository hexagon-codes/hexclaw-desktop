/**
 * bug-20260718 · 冻结违规回归锁（零容忍）：前端不得暴露初中年级或物理/化学学科。
 *
 * 根因：curriculum.GRADES 曾含初一/初二/初三共 18 档；subjects.K12_GRADE_SUBJECT_OPTIONS
 * 曾含物理/化学。违反 K12-INV-014「当前 Manifest 不暴露初中、高中、物理、化学或音乐」与
 * 架构 §1.3 v0.5.0 学科口径（数学/语文/英语/科学/信息科技，subject 取值权威见 §4.11 line 1015）。
 *
 * 本锁把「小学 12 档 + 五学科无物化」钉死为永久契约：任何回填初中年级或物化学科即 FAIL。
 */
import { describe, it, expect } from 'vitest'
import { GRADES } from '../curriculum'
import { K12_GRADE_SUBJECT_OPTIONS } from '../subjects'

describe('bug-20260718 · 冻结违规：年级与学科口径', () => {
  it('GRADES 只含小学 12 档，无任何初中年级', () => {
    expect(GRADES).toHaveLength(12)
    for (const g of GRADES) {
      expect(g).not.toContain('初')
    }
  })

  it('GRADES 是一~六年级上下两学期', () => {
    expect(GRADES).toEqual([
      '一年级上', '一年级下',
      '二年级上', '二年级下',
      '三年级上', '三年级下',
      '四年级上', '四年级下',
      '五年级上', '五年级下',
      '六年级上', '六年级下',
    ])
  })

  it('批改学科不含物理/化学，且对齐 §1.3 五学科口径', () => {
    const values = K12_GRADE_SUBJECT_OPTIONS.map((o) => o.value)
    expect(values).not.toContain('物理')
    expect(values).not.toContain('化学')
    // 美术非批改学科（进作品不进错题，subject 取值非法）
    expect(values).not.toContain('美术')
    expect(values).toEqual(['数学', '语文', '英语', '科学', '信息科技'])
  })
})
