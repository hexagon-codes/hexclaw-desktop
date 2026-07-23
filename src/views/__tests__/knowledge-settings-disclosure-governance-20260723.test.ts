import { describe, expect, it } from 'vitest'
import knowledgeView from '../KnowledgeView.vue?raw'
import semanticIndexCard from '@/components/knowledge/SemanticIndexCard.vue?raw'
import memorySettingsPanel from '@/components/memory/MemorySettingsPanel.vue?raw'

describe('Knowledge settings disclosure governance', () => {
  it('uses one shared disclosure shell for all three approved settings surfaces', () => {
    expect(semanticIndexCard).toContain('<HcSettingsDisclosure')
    expect(knowledgeView).toContain('<HcSettingsDisclosure')
    expect(memorySettingsPanel).toContain('<HcSettingsDisclosure')
  })

  it('keeps semantic index in the documents panel and retrieval settings in search only', () => {
    const tabs = knowledgeView.indexOf('<UnderlineTabs')
    const activePanel = knowledgeView.indexOf('class="knowledge-page__active-panel"')
    const semanticIndex = knowledgeView.indexOf('<SemanticIndexCard', activePanel)
    const sourceFilters = knowledgeView.indexOf('data-testid="knowledge-source-filters"')
    const searchPanel = knowledgeView.indexOf('<!-- 检索测试标签 -->')
    const ragDisclosure = knowledgeView.indexOf('<HcSettingsDisclosure', searchPanel)

    expect(tabs).toBeGreaterThan(-1)
    expect(activePanel).toBeGreaterThan(tabs)
    expect(semanticIndex).toBeGreaterThan(activePanel)
    expect(knowledgeView.slice(semanticIndex, semanticIndex + 160)).toContain(
      "activeTab === 'documents'",
    )
    expect(sourceFilters).toBeGreaterThan(semanticIndex)
    expect(searchPanel).toBeGreaterThan(sourceFilters)
    expect(ragDisclosure).toBeGreaterThan(searchPanel)
    expect(knowledgeView.slice(searchPanel, ragDisclosure)).not.toContain('<SemanticIndexCard')
  })
})
