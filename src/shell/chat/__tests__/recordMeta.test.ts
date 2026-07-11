import { describe, it, expect } from 'vitest'
import { parseRecordMeta } from '../recordMeta'

/**
 * BUG-1：后端 reply.Metadata 是 map[string]string，record 入库徽章以 JSON 字符串透传
 * （engine 层领域中立转发）。messageRecordChip 原来 `msg.metadata.record as {...}` 直接当
 * 对象，遇到 JSON 字符串会拿不到 collection → 徽章恒不显。parseRecordMeta 须容忍字符串与对象。
 */
describe('parseRecordMeta（BUG-1 record 徽章元数据解析）', () => {
  const rec = { collection: '错题本', fields: { question: '3.8×3', knowledge_point: '小数乘法' }, status: 'new' }

  it('容忍后端 JSON 字符串 record（主修复路径）', () => {
    const parsed = parseRecordMeta({ record: JSON.stringify(rec) })
    expect(parsed).not.toBeNull()
    expect(parsed?.collection).toBe('错题本')
    expect(parsed?.fields?.knowledge_point).toBe('小数乘法')
    expect(parsed?.status).toBe('new')
  })

  it('兼容已是对象的 record（前端写回/老路径）', () => {
    const parsed = parseRecordMeta({ record: rec })
    expect(parsed?.collection).toBe('错题本')
  })

  it('无 record / 非法 JSON / 缺 collection → null（不渲染空徽章）', () => {
    expect(parseRecordMeta(null)).toBeNull()
    expect(parseRecordMeta({})).toBeNull()
    expect(parseRecordMeta({ record: '不是json' })).toBeNull()
    expect(parseRecordMeta({ record: '{"fields":{}}' })).toBeNull()
  })
})
