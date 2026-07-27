import { describe, it, expect } from 'vitest'
import { mistakeToRecord, mistakesToView, gradeToResult, gradeToVerify } from '../mappers'
import { MISTAKE_SCHEMA, MISTAKE_COLLECTION } from '../schemas'
import type { MistakeDTO, GradeResp } from '@/api/k12'

const dto = (over: Partial<MistakeDTO> = {}): MistakeDTO => ({
  record_id: 'r1',
  question: '3.8×3=?',
  knowledge_point: '小数乘法',
  error_cause: '计算失误·进位',
  status: 'scheduled',
  review_state: 'scheduled',
  version: 0,
  due_at: 1710000000,
  ...over,
})

const grade = (over: Partial<GradeResp> = {}): GradeResp => ({
  solution: '解：11.4',
  verdict: 'agree',
  evidence_type: 'numeric_exec',
  badge: 'verified-strong',
  out_of_scope: false,
  record_created: true,
  record_id: 'r9',
  ...over,
})

describe('K12 mappers · mistakeDTO → RecordItem', () => {
  it('字段投影进 fields，key 与 MISTAKE_SCHEMA 对齐', () => {
    const r = mistakeToRecord(dto(), 'mingming')
    expect(r.recordId).toBe('r1')
    expect(r.agentId).toBe('mingming')
    expect(r.collection).toBe(MISTAKE_COLLECTION)
    // schema 里 title/chip/meta 三个字段的 key 都必须在 fields 里能取到
    const keys = MISTAKE_SCHEMA.fields.map((f) => f.key)
    for (const k of keys) expect(r.fields).toHaveProperty(k)
    expect(r.status).toBe('scheduled')
    expect(r.dueAt).toBe(1710000000)
  })

  it('due_at 缺省 → null', () => {
    expect(mistakeToRecord(dto({ due_at: undefined }), 'a').dueAt).toBeNull()
  })
})

describe('K12 mappers · mistakesToView', () => {
  it('复习队列取自 due 列表 id，statusCounts 按状态聚合', () => {
    const all = [
      dto({ record_id: 'a', status: 'scheduled', review_state: 'scheduled' }),
      dto({ record_id: 'b', status: 'mastered', review_state: 'mastered' }),
    ]
    const due = [dto({ record_id: 'a' })]
    const v = mistakesToView('ming', all, due)
    expect(v.items).toHaveLength(2)
    expect(v.reviewQueue).toEqual(['a'])
    expect(v.statusCounts).toEqual({ scheduled: 1, mastered: 1 })
  })

  it('把 review-queue 独有的积累纠错记录合并进 items，不让通用 RecordList 丢队列项', () => {
    const all = [dto({ record_id: 'math-1', subject: undefined })]
    const due = [
      dto({ record_id: 'math-1', subject: '数学', review_kind: 'verify' }),
      dto({
        record_id: 'lang-1',
        question: '再默一遍：蒹葭苍苍',
        knowledge_point: '默写错',
        error_cause: 'verbatim',
        status: '待复习',
        subject: '语文',
        review_kind: 'verbatim',
      }),
    ]

    const v = mistakesToView('ming', all, due)
    expect(v.reviewQueue).toEqual(['math-1', 'lang-1'])
    expect(v.items.map((item) => item.recordId)).toEqual(['math-1', 'lang-1'])
    expect(v.items[1]?.fields).toMatchObject({ subject: '语文', review_kind: 'verbatim' })
  })
})

describe('K12 mappers · gradeResp → VerifyResult（三态诚实）', () => {
  it('verified-strong → agree + 强证据', () => {
    const v = gradeToVerify(grade({ badge: 'verified-strong' }))
    expect(v).toEqual({ verdict: 'agree', evidence: 'program_verified' })
  })
  it('verified-weak → agree + 弱证据（不显"已程序验算"）', () => {
    const v = gradeToVerify(grade({ badge: 'verified-weak', evidence_type: 'heuristic' }))
    expect(v.verdict).toBe('agree')
    expect(v.evidence).toBe('model_review')
  })
  it('disagree → 不一致', () => {
    expect(gradeToVerify(grade({ badge: 'disagree' })).verdict).toBe('disagree')
  })
  it('out-of-scope → 超纲 + 带越界知识点', () => {
    const v = gradeToVerify(grade({ badge: 'out-of-scope', out_of_scope: true, out_of_scope_kp: '二元一次方程组' }))
    expect(v.verdict).toBe('out_of_scope')
    expect(v.outOfScope?.detected).toBe('二元一次方程组')
  })
  it('以后端 out_of_scope 布尔值为准，即使旧后端 badge 仍是 unverifiable', () => {
    const v = gradeToVerify(grade({ badge: 'unverifiable', evidence_type: 'none', out_of_scope: true, out_of_scope_kp: '二元一次方程组' }))
    expect(v.verdict).toBe('out_of_scope')
    expect(v.outOfScope?.detected).toBe('二元一次方程组')
  })
  it('unverifiable → 无法独立验证', () => {
    expect(gradeToVerify(grade({ badge: 'unverifiable' })).verdict).toBe('unverifiable')
  })
})

describe('K12 mappers · gradeResp → 完整批改结果', () => {
  it('保留解答、判定、错步、错因和原始证据字段', () => {
    const result = gradeToResult(grade({
      solution: '解：3.8×3=11.4',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      wrong_step: '小数点错位',
      error_cause: '对位错误',
    }))

    expect(result).toMatchObject({
      solution: '解：3.8×3=11.4',
      verdict: 'disagree',
      evidenceType: 'numeric_exec',
      badge: 'disagree',
      wrongStep: '小数点错位',
      errorCause: '对位错误',
    })
  })

  it('反向契约（§4.5 布尔删除）：批改结果不再含布尔 correct 键，判定统一 verdict 五值', () => {
    const result = gradeToResult(grade({ verdict: 'disagree' }))
    expect('correct' in result).toBe(false)
    expect(result.verdict).toBe('disagree')
  })

  it('record_created=false + record_id 表示命中去重：仍已入本，同时保留“非本次新建”语义', () => {
    const result = gradeToResult(grade({ record_created: false, record_id: 'existing-r9' }))
    expect(result.recordCreated).toBe(true)
    expect(result.recordNewlyCreated).toBe(false)
    expect(result.recordDeduplicated).toBe(true)
    expect(result.recordId).toBe('existing-r9')
  })
})
