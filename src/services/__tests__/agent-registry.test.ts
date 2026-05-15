import { describe, it, expect, beforeEach } from 'vitest'
import { getAgentRegistry } from '../agentRegistry'
import type { AgentDefinition } from '../agentRegistry'

// ── Helpers ───────────────────────────────────────

function makeAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  const name = overrides?.agentName ?? 'test-agent'
  return {
    skillId: 'test-skill',
    agentName: name,
    description: 'A test agent',
    mdPath: `agents/${name}.md`,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────

describe('AgentRegistry', () => {
  let registry: ReturnType<typeof getAgentRegistry>

  beforeEach(() => {
    registry = getAgentRegistry()
    // 清理所有已注册的代理
    for (const agent of registry.getAllAgents()) {
      registry.unregisterSkill(agent.skillId)
    }
  })

  // ── registerAgents ───────────────────────────────

  describe('registerAgents', () => {
    it('registers agents from AgentDefinition array', () => {
      const agents = [
        makeAgent({ agentName: 'code-reviewer' }),
        makeAgent({ agentName: 'doc-writer' }),
      ]

      registry.registerAgents('test-skill', agents)

      const all = registry.getAllAgents()
      expect(all).toHaveLength(2)
      expect(all.map((a) => a.agentName).sort()).toEqual(['code-reviewer', 'doc-writer'])
    })

    it('sets correct metadata on registered agents', () => {
      const agents = [
        makeAgent({
          agentName: 'my-agent',
          description: 'My agent',
          model: 'claude-sonnet-4-6',
          tools: ['read', 'write'],
        }),
      ]

      registry.registerAgents('my-skill', agents)

      const agent = registry.findAgent('my-agent')
      expect(agent).toBeDefined()
      expect(agent!.skillId).toBe('my-skill')
      expect(agent!.agentName).toBe('my-agent')
      expect(agent!.description).toBe('My agent')
      expect(agent!.mdPath).toBe('agents/my-agent.md')
      expect(agent!.model).toBe('claude-sonnet-4-6')
      expect(agent!.tools).toEqual(['read', 'write'])
    })

    it('handles empty agents array', () => {
      registry.registerAgents('empty-skill', [])

      expect(registry.getAllAgents()).toHaveLength(0)
    })
  })

  // ── findAgent ────────────────────────────────────

  describe('findAgent', () => {
    it('finds agent by exact name', () => {
      registry.registerAgents('skill-1', [
        makeAgent({ agentName: 'reviewer' }),
      ])

      const found = registry.findAgent('reviewer')
      expect(found).toBeDefined()
      expect(found!.skillId).toBe('skill-1')
    })

    it('finds agent case-insensitively', () => {
      registry.registerAgents('skill-1', [
        makeAgent({ agentName: 'MyAgent' }),
      ])

      const found = registry.findAgent('myagent')
      expect(found).toBeDefined()
      expect(found!.agentName).toBe('MyAgent')
    })

    it('returns undefined for unknown agent', () => {
      const found = registry.findAgent('nonexistent')
      expect(found).toBeUndefined()
    })
  })

  // ── findAgentBySkill ─────────────────────────────

  describe('findAgentBySkill', () => {
    it('returns all agents for a skill', () => {
      registry.registerAgents('skill-a', [
        makeAgent({ agentName: 'agent-a1', skillId: 'skill-a' }),
        makeAgent({ agentName: 'agent-a2', skillId: 'skill-a' }),
      ])
      registry.registerAgents('skill-b', [
        makeAgent({ agentName: 'agent-b1', skillId: 'skill-b' }),
      ])

      const agents = registry.findAgentBySkill('skill-a')
      expect(agents).toHaveLength(2)
      expect(agents.map((a) => a.agentName).sort()).toEqual(['agent-a1', 'agent-a2'])
    })

    it('returns empty array for skill with no agents', () => {
      const agents = registry.findAgentBySkill('nonexistent')
      expect(agents).toEqual([])
    })
  })

  // ── unregisterSkill ──────────────────────────────

  describe('unregisterSkill', () => {
    it('removes all agents for a skill', () => {
      registry.registerAgents('skill-a', [
        makeAgent({ agentName: 'agent-a1', skillId: 'skill-a' }),
        makeAgent({ agentName: 'agent-a2', skillId: 'skill-a' }),
      ])
      registry.registerAgents('skill-b', [
        makeAgent({ agentName: 'agent-b1', skillId: 'skill-b' }),
      ])

      registry.unregisterSkill('skill-a')

      expect(registry.findAgent('agent-a1')).toBeUndefined()
      expect(registry.findAgent('agent-a2')).toBeUndefined()
      expect(registry.findAgent('agent-b1')).toBeDefined()
    })

    it('handles unregistering non-existent skill', () => {
      registry.unregisterSkill('nonexistent')

      expect(registry.getAllAgents()).toHaveLength(0)
    })

    it('allows re-registering agents after unregister', () => {
      registry.registerAgents('skill-x', [
        makeAgent({ agentName: 'agent-x1', skillId: 'skill-x' }),
      ])
      registry.unregisterSkill('skill-x')

      registry.registerAgents('skill-x', [
        makeAgent({ agentName: 'agent-x2', skillId: 'skill-x' }),
      ])

      expect(registry.findAgent('agent-x1')).toBeUndefined()
      expect(registry.findAgent('agent-x2')).toBeDefined()
    })
  })

  // ── getAllAgents ──────────────────────────────────

  describe('getAllAgents', () => {
    it('returns empty array when no agents registered', () => {
      expect(registry.getAllAgents()).toEqual([])
    })

    it('returns all registered agents', () => {
      registry.registerAgents('s1', [
        makeAgent({ agentName: 'a', skillId: 's1' }),
        makeAgent({ agentName: 'b', skillId: 's1' }),
      ])
      registry.registerAgents('s2', [
        makeAgent({ agentName: 'c', skillId: 's2' }),
      ])

      const all = registry.getAllAgents()
      expect(all).toHaveLength(3)
      expect(all.map((a) => a.agentName).sort()).toEqual(['a', 'b', 'c'])
    })
  })
})
