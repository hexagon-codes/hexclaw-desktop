/**
 * 抽查复验前端契约（任务4，架构设计-v0.5.0 §3.6 规则 1/4）：
 *   - MistakeDTO.spot_check_state 经 mapper 透传进 RecordItem.fields（详情据此呈现
 *     「家长确认（复验未过）」事实标注）；
 *   - 仅 failed 有呈现语义；scheduled 不打「抽查」标签（详情逻辑只匹配 failed）。
 */
import { describe, it, expect } from 'vitest'
import { mistakeToRecord, mistakesToView } from '../mappers'
import type { MistakeDTO } from '@/api/k12'

function dto(over: Partial<MistakeDTO> = {}): MistakeDTO {
  return {
    record_id: 'm1', question: '3.8×3=?', knowledge_point: '小数乘法',
    error_cause: '计算失误', status: 'retried', version: 3, ...over,
  }
}

describe('抽查复验 · spot_check_state 透传', () => {
  it('failed 透传进 fields（详情「家长确认（复验未过）」的数据依据）', () => {
    const rec = mistakeToRecord(dto({ spot_check_state: 'failed' }), 'k12-xiaoming')
    expect(rec.fields.spot_check_state).toBe('failed')
  })

  it('缺省/scheduled 同样透传但不等于 failed（呈现层只匹配 failed，不打抽查标签）', () => {
    expect(mistakeToRecord(dto(), 'a').fields.spot_check_state).toBeUndefined()
    expect(mistakeToRecord(dto({ spot_check_state: 'scheduled' }), 'a').fields.spot_check_state).toBe('scheduled')
  })

  it('mistakesToView 合并列表后仍保留 spot_check_state', () => {
    const view = mistakesToView('a', [dto({ spot_check_state: 'failed' })], [])
    expect(view.items[0]!.fields.spot_check_state).toBe('failed')
  })
})
