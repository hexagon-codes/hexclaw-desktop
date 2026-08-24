import { describe, expect, it } from 'vitest'

import practicePanelSource from '../views/K12PracticeSetsPanel.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import projectionSource from '../practice-generation-projection?raw'

describe('BUG-20260728-001 三表面练习集耐久投影', () => {
  it('练习集面板读取 generation 并投影 pending placeholder，而不是只读 PracticeSetItem', () => {
    expect(practicePanelSource).toContain('practiceGenerationByMistake')
    expect(practicePanelSource).toContain('正在生成练习题…')
    expect(practicePanelSource).toMatch(/pendingGenerations[\s\S]*state === 'pending'/s)
  })

  it('既有按钮只触发共享 generation，练习集移除后继续刷新共享状态', () => {
    expect(recordsSource).not.toContain('K12PracticeCandidateSelectionModal')
    expect(recordsSource).not.toContain('commitPracticeCandidateSelection')
    expect(recordsSource).not.toContain('k12OpenMistakePracticeCandidates')
    expect(recordsSource).toMatch(
      /async function runPracticeGeneration[\s\S]*?k12StartMistakePracticeGeneration[\s\S]*?schedulePracticePoll\(\)/s,
    )
    expect(recordsSource).toContain('@click="runPracticeGeneration(item.recordId)"')
    expect(recordsSource).toContain('@generation-invalidated="onPracticeGenerationInvalidated"')
    expect(recordsSource).toMatch(
      /async function onPracticeGenerationInvalidated[\s\S]*?reloadPracticeGenerationStates\(\)/s,
    )
    expect(practicePanelSource).toContain("emit('generation-invalidated'")
  })

  it('generation 查询失败必须进入不可执行未知态，不能默认为加入练习集', () => {
    expect(recordsSource).toContain("state: 'unknown'")
    expect(projectionSource).toContain("case 'unknown'")
    expect(projectionSource).toMatch(/case 'unknown'[\s\S]*kind: 'unavailable'/s)
  })
})
