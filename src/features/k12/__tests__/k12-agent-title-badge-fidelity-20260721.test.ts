import { describe, expect, it } from 'vitest'

import agentsSource from '@/views/AgentsView.vue?raw'
import registrySource from '@/shell/scenario/registry.ts?raw'
import registerSource from '../register.ts?raw'
import cardSource from '../views/K12AgentCard.vue?raw'

describe('K12 智能体卡标题徽章 · app.html 保真锁', () => {
  it('K12 标签由通用 registry 注入标题行，扩展内容不再另起身份行', () => {
    const rosterName = agentsSource.indexOf('{{ agentDisplayName(agent) }}')
    const titleStart = agentsSource.lastIndexOf('class="hc-cxnm hc-cxnm--card"', rosterName)
    const metaStart = agentsSource.indexOf('class="hc-cxmeta', titleStart)
    const titleSource = agentsSource.slice(titleStart, metaStart)

    expect(rosterName).toBeGreaterThan(-1)
    expect(titleStart).toBeGreaterThan(-1)
    expect(metaStart).toBeGreaterThan(titleStart)
    expect(registrySource).toContain('registerAgentCardBadge')
    expect(registerSource).toContain("registerAgentCardBadge('k12.agentCard.tag')")
    expect(titleSource).toContain('agentCardBadgeKey')
    expect(titleSource).toContain('data-testid="scenario-agent-title-badge"')
    expect(cardSource).not.toContain('data-testid="k12-agent-tag"')
  })
})
