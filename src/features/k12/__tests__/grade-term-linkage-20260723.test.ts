import { describe, expect, it } from 'vitest'
import {
  PRIMARY_GRADES,
  SEMESTERS,
  joinGradeTerm,
  splitGradeTerm,
} from '../curriculum'

describe('K12 年级 × 学期二级联动契约', () => {
  it('只暴露小学六个年级与上/下两个学期', () => {
    expect(PRIMARY_GRADES).toEqual([
      '一年级',
      '二年级',
      '三年级',
      '四年级',
      '五年级',
      '六年级',
    ])
    expect(SEMESTERS).toEqual(['上', '下'])
  })

  it.each([
    '一年级上',
    '一年级下',
    '二年级上',
    '二年级下',
    '三年级上',
    '三年级下',
    '四年级上',
    '四年级下',
    '五年级上',
    '五年级下',
    '六年级上',
    '六年级下',
  ])('对既有 grade_term=%s 无损拆分并按原契约还原', (gradeTerm) => {
    const parsed = splitGradeTerm(gradeTerm)
    expect(joinGradeTerm(parsed.grade, parsed.semester)).toBe(gradeTerm)
  })
})
