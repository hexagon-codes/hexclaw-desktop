/**
 * CommandRegistry — Claude Code 命令注册表
 *
 * 管理 skill.json 中声明的 commands/*.md 文件，
 * 支持 /command 触发路由。
 *
 * 职责：
 * - 注册/注销 skill 关联的命令
 * - 按 trigger 查找命令定义
 * - 维护 trigger → CommandDefinition 映射
 *
 * 不做：
 * - 命令内容加载（由 SkillBridge 负责）
 * - 命令执行（由 runtimeBridge 负责）
 */

import type { SkillCommand } from '@/types/skill'

// ─── Types ─────────────────────────────────────────────

/** 命令定义（从 SkillCommand + skillId 构建） */
export interface CommandDefinition {
  skillId: string
  commandName: string
  description: string
  trigger: string        // e.g. '/summarize'
  mdPath: string         // path to the .md file
  source: 'skill-package' | 'claude-code-import'
}

// ─── CommandRegistry ───────────────────────────────────

/**
 * 命令注册表（模块级单例）。
 *
 * 线程安全：单线程 JS 环境，无需加锁。
 * 生命周期：跟随应用，不持久化。
 */
class CommandRegistryImpl {
  /** trigger → CommandDefinition 映射 */
  private commands = new Map<string, CommandDefinition>()

  /** skillId → trigger[] 反向索引（用于 unregisterSkill） */
  private skillIndex = new Map<string, string[]>()

  /**
   * 注册 skill 关联的命令。
   *
   * @param skillId — 所属 skill ID
   * @param commands — skill.json 中的 commands 数组
   * @param source — 命令来源标记
   */
  registerCommands(
    skillId: string,
    commands: SkillCommand[],
    source: CommandDefinition['source'] = 'skill-package',
  ): void {
    for (const cmd of commands) {
      const trigger = `/${cmd.name}`.toLowerCase()
      const def: CommandDefinition = {
        skillId,
        commandName: cmd.name,
        description: cmd.description ?? '',
        trigger,
        mdPath: cmd.file,
        source,
      }
      this.commands.set(trigger, def)

      // 维护反向索引
      const triggers = this.skillIndex.get(skillId) ?? []
      triggers.push(trigger)
      this.skillIndex.set(skillId, triggers)
    }
  }

  /**
   * 注销指定 skill 的所有命令。
   *
   * @param skillId — 要注销的 skill ID
   */
  unregisterSkill(skillId: string): void {
    const triggers = this.skillIndex.get(skillId)
    if (!triggers) return

    for (const trigger of triggers) {
      this.commands.delete(trigger)
    }
    this.skillIndex.delete(skillId)
  }

  /**
   * 按 trigger 查找命令（忽略大小写）。
   *
   * @param trigger — 触发词（如 '/summarize' 或 'summarize'）
   * @returns 匹配的 CommandDefinition，未找到返回 undefined
   */
  findCommand(trigger: string): CommandDefinition | undefined {
    const normalized = trigger.startsWith('/') ? trigger : `/${trigger}`
    return this.commands.get(normalized.toLowerCase())
  }

  /**
   * 获取所有已注册的命令。
   */
  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values())
  }
}

// ─── 模块级单例 ────────────────────────────────────────

let _instance: CommandRegistryImpl | undefined

export function getCommandRegistry(): CommandRegistryImpl {
  if (!_instance) _instance = new CommandRegistryImpl()
  return _instance
}

// 导出类型供外部使用
export type { CommandDefinition as CommandDef }
