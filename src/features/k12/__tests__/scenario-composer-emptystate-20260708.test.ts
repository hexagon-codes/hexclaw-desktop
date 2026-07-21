/** 权威原型漂移锁：K12 不注入 app.html 中不存在的会话空态卡或重复工具栏动作。 */
import { describe, it, expect } from 'vitest'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

describe('K12 权威原型空态与入口契约', () => {
  it('K12 descriptor 不声明原型外的会话空态卡', () => {
    expect(K12_VIEW_DESCRIPTOR.emptyState).toBeUndefined()
  })

  it('P0-2 撤销 · descriptor 不声明 managedModel（会话框与普通会话统一）', () => {
    expect(
      (K12_VIEW_DESCRIPTOR.composer as { managedModel?: boolean } | undefined)?.managedModel,
    ).toBeUndefined()
  })

  it('导出与备份入口只由学习档案承载，不保留未消费的重复 toolbar 声明', () => {
    expect(K12_VIEW_DESCRIPTOR.actions).toEqual([])
  })
})
