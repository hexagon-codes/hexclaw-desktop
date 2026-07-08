import { describe, it, expect } from 'vitest'
import { mistakeToRecord, mistakesToView, gradeToVerify } from '../mappers'
import { MISTAKE_SCHEMA, MISTAKE_COLLECTION } from '../schemas'
import type { MistakeDTO, GradeResp } from '@/api/k12'

const dto = (over: Partial<MistakeDTO> = {}): MistakeDTO => ({
  record_id: 'r1',
  question: '3.8×3=?',
  knowledge_point: '小数乘法',
  error_cause: '计算失误·进位',
  status: 'new',
  version: 0,
  due_at: 1710000000,
  ...over,
})

const grade = (over: Partial<GradeResp> = {}): GradeResp => ({
  solution: '解：11.4',
  verdict: 'agree',
  evidence_type: 'numeric_exec',
  badge: 'verified-strong',
  correct: false,
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
    expect(r.status).toBe('new')
    expect(r.dueAt).toBe(1710000000)
  })

  it('due_at 缺省 → null', () => {
    expect(mistakeToRecord(dto({ due_at: undefined }), 'a').dueAt).toBeNull()
  })
})

describe('K12 mappers · mistakesToView', () => {
  it('复习队列取自 due 列表 id，statusCounts 按状态聚合', () => {
    const all = [dto({ record_id: 'a', status: 'new' }), dto({ record_id: 'b', status: 'mastered' })]
    const due = [dto({ record_id: 'a' })]
    const v = mistakesToView('ming', all, due)
    expect(v.items).toHaveLength(2)
    expect(v.reviewQueue).toEqual(['a'])
    expect(v.statusCounts).toEqual({ new: 1, mastered: 1 })
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
  it('unverifiable → 无法独立验证', () => {
    expect(gradeToVerify(grade({ badge: 'unverifiable' })).verdict).toBe('unverifiable')
  })
})
