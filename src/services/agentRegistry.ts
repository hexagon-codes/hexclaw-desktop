/**
 * AgentRegistry — Skill sub-agent 注册表。
 *
 * 管理 skill.json 中声明的 agents/*.md 文件，
 * 支持 @agent 触发路由。
 *
 * 职责：
 * - 注册/注销 skill 关联的子代理
 * - 按名称查找代理定义
 * - 维护 name → AgentDefinition 映射
 *
 * 不做：
 * - 代理内容加载（由 AgentExecutor 负责）
 * - 代理执行（由 AgentExecutor 负责）
 */

import type { SkillAgent } from '@/types/skill'

// ─── Types ─────────────────────────────────────────────

/** 代理定义（从 SkillAgent + skillId 构建） */
export interface AgentDefinition {
  skillId: string
  agentName: string
  description: string
  mdPath: string        // path to the agents/*.md file
  model?: string        // optional model override
  tools?: string[]      // allowed tools list
  maxTurns?: number     // conversation turn limit
}

// ─── AgentRegistry ─────────────────────────────────────

/**
 * 子代理注册表（模块级单例）。
 *
 * 线程安全：单线程 JS 环境，无需加锁。
 * 生命周期：跟随应用，不持久化。
 */
class AgentRegistryImpl {
  /** name → AgentDefinition 映射 */
  private agents = new Map<string, AgentDefinition>()

  /** skillId → name[] 反向索引（用于 unregisterSkill） */
  private skillIndex = new Map<string, string[]>()

  /**
   * 注册 skill 关联的子代理。
   *
   * @param skillId — 所属 skill ID
   * @param agents — skill.json 中的 agents 数组
   */
  registerAgents(skillId: string, agents: AgentDefinition[]): void {
    for (const agent of agents) {
      const key = agent.agentName.toLowerCase()
      const def: AgentDefinition = {
        ...agent,
        skillId,
      }
      this.agents.set(key, def)

      // 维护反向索引
      const names = this.skillIndex.get(skillId) ?? []
      names.push(key)
      this.skillIndex.set(skillId, names)
    }
  }

  /**
   * 注销指定 skill 的所有子代理。
   *
   * @param skillId — 要注销的 skill ID
   */
  unregisterSkill(skillId: string): void {
    const names = this.skillIndex.get(skillId)
    if (!names) return

    for (const name of names) {
      this.agents.delete(name)
    }
    this.skillIndex.delete(skillId)
  }

  /**
   * 按名称查找代理（忽略大小写）。
   *
   * @param name — 代理名称
   * @returns 匹配的 AgentDefinition，未找到返回 undefined
   */
  findAgent(name: string): AgentDefinition | undefined {
    return this.agents.get(name.toLowerCase())
  }

  /**
   * 查找指定 skill 的所有子代理。
   *
   * @param skillId — skill ID
   * @returns 该 skill 注册的代理列表
   */
  findAgentBySkill(skillId: string): AgentDefinition[] {
    const names = this.skillIndex.get(skillId) ?? []
    return names.map((n) => this.agents.get(n)).filter((a): a is AgentDefinition => !!a)
  }

  /**
   * 获取所有已注册的代理。
   */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }
}

// ─── 模块级单例 ────────────────────────────────────────

let _instance: AgentRegistryImpl | undefined

export function getAgentRegistry(): AgentRegistryImpl {
  if (!_instance) _instance = new AgentRegistryImpl()
  return _instance
}
