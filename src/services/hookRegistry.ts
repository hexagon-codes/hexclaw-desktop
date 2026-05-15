/**
 * hookRegistry -- Skill 生命周期 Hook 注册中心。
 *
 * 纯函数模块 + 模块级单例。
 * 职责：
 * - 管理 skill 注册的 lifecycle hooks
 * - 按事件类型 / skillId 查询 hooks
 * - 支持批量注册和按 skillId 注销
 */

// ── Types ─────────────────────────────────────────

export type HookEvent = 'on-load' | 'on-execute' | 'on-error' | 'on-unload' | 'on-message'

export interface HookDefinition {
  skillId: string
  hookName: string
  event: HookEvent
  /** .sh 文件路径（相对于 skill 目录） */
  scriptPath: string
  /** 超时时间 ms，默认 5000 */
  timeout?: number
}

// ── HookRegistry ──────────────────────────────────

export class HookRegistry {
  /** event → HookDefinition[] */
  private byEvent: Map<HookEvent, HookDefinition[]> = new Map()
  /** skillId → HookDefinition[] */
  private bySkill: Map<string, HookDefinition[]> = new Map()

  /**
   * 注册一组 hooks。
   *
   * @param skillId — 技能 ID
   * @param hooks — 该技能声明的 hooks
   */
  registerHooks(skillId: string, hooks: HookDefinition[]): void {
    if (!hooks.length) return

    for (const hook of hooks) {
      // 确保 skillId 一致
      const normalized: HookDefinition = { ...hook, skillId }

      // byEvent
      const eventHooks = this.byEvent.get(normalized.event) ?? []
      eventHooks.push(normalized)
      this.byEvent.set(normalized.event, eventHooks)

      // bySkill
      const skillHooks = this.bySkill.get(skillId) ?? []
      skillHooks.push(normalized)
      this.bySkill.set(skillId, skillHooks)
    }
  }

  /**
   * 注销指定 skill 的所有 hooks。
   *
   * @param skillId — 技能 ID
   */
  unregisterSkill(skillId: string): void {
    const skillHooks = this.bySkill.get(skillId)
    if (!skillHooks) return

    for (const hook of skillHooks) {
      const eventHooks = this.byEvent.get(hook.event)
      if (eventHooks) {
        const idx = eventHooks.indexOf(hook)
        if (idx !== -1) eventHooks.splice(idx, 1)
      }
    }
    this.bySkill.delete(skillId)
  }

  /**
   * 获取指定事件的所有 hooks。
   *
   * @param event — 事件类型
   * @returns 该事件的 hooks 列表（浅拷贝）
   */
  getHooksForEvent(event: HookEvent): HookDefinition[] {
    return [...(this.byEvent.get(event) ?? [])]
  }

  /**
   * 获取指定 skill 的所有 hooks。
   *
   * @param skillId — 技能 ID
   * @returns 该 skill 的 hooks 列表（浅拷贝）
   */
  getHooksForSkill(skillId: string): HookDefinition[] {
    return [...(this.bySkill.get(skillId) ?? [])]
  }

  /** 已注册 skill 数量 */
  get size(): number {
    return this.bySkill.size
  }
}

// ── 模块级单例 ────────────────────────────────────

let _instance: HookRegistry | undefined

export function getHookRegistry(): HookRegistry {
  if (!_instance) _instance = new HookRegistry()
  return _instance
}
