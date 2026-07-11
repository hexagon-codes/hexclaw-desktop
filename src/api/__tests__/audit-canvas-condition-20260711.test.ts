/**
 * C6 前端：condition 节点配置校验（与后端 workflow_condition.go 对齐）。
 * 保证保存/运行前把非法 op / 缺 target / target 非出边 / default 非出边 提前暴露。
 */
import { describe, it, expect } from 'vitest'
import { validateConditionConfig, parseConditionConfig } from '@/api/canvas-condition'
import type { CanvasEdge } from '@/types/canvas'

const edges: CanvasEdge[] = [
  { id: 'e1', from: 'cond', to: 'branchA' },
  { id: 'e2', from: 'cond', to: 'branchB' },
]

describe('C6 · validateConditionConfig', () => {
  it('合法配置（op 有效 + target 是出边 + default 是出边）无错误', () => {
    const cfg = {
      source: 'input',
      conditions: [{ op: 'eq', value: 'go', target: 'branchA' }],
      default: 'branchB',
    }
    expect(validateConditionConfig('cond', cfg, edges)).toEqual([])
  })

  it('非法 op 报错', () => {
    const cfg = { conditions: [{ op: 'no_such', value: 'x', target: 'branchA' }] }
    expect(validateConditionConfig('cond', cfg, edges).some((e) => e.includes('op'))).toBe(true)
  })

  it('缺 target 报错', () => {
    const cfg = { conditions: [{ op: 'eq', value: 'x' }] }
    expect(validateConditionConfig('cond', cfg, edges).some((e) => e.includes('target'))).toBe(true)
  })

  it('target 不是本节点出边报错', () => {
    const cfg = { conditions: [{ op: 'eq', value: 'x', target: 'nowhere' }] }
    expect(validateConditionConfig('cond', cfg, edges).some((e) => e.includes('nowhere'))).toBe(true)
  })

  it('default 不是出边报错', () => {
    const cfg = { conditions: [{ op: 'eq', value: 'x', target: 'branchA' }], default: 'ghost' }
    expect(validateConditionConfig('cond', cfg, edges).some((e) => e.includes('ghost'))).toBe(true)
  })

  it('无条件规则 = 占位直通，合法（向后兼容）', () => {
    expect(validateConditionConfig('cond', {}, edges)).toEqual([])
    expect(validateConditionConfig('cond', { conditions: [] }, edges)).toEqual([])
  })

  it('parseConditionConfig 宽松解析非字符串 value', () => {
    const cfg = parseConditionConfig({ conditions: [{ op: 'gt', value: 5, target: 'branchA' }] })
    expect(cfg.conditions[0]).toMatchObject({ op: 'gt', value: '5', target: 'branchA' })
  })
})
