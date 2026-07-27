import { describe, expect, it } from 'vitest'

import panelSource from '../components/K12WeeklyPracticePanel.vue?raw'

describe('BUG-20260727-006 weekly contextual copy authority', () => {
  it('uses explicit progress actions without trailing ellipsis', () => {
    expect(panelSource).toMatch(/>\s*设置教材进度\s*</)
    expect(panelSource).toMatch(/>\s*调整进度\s*</)
    expect(panelSource).not.toContain('设置教材进度…')
    expect(panelSource).not.toContain('调整…')
  })

  it('keeps idle generation labels stable while count remains in the shared field', () => {
    expect(panelSource).toContain('生成同步巩固题')
    expect(panelSource).toContain('生成口算热身题')
    expect(panelSource).not.toContain('`生成 ${selectedTextbookItemCount')
    expect(panelSource).not.toContain('`生成 ${selectedArithmeticItemCount')
  })
})
