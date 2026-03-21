/** 后端返回的 Skill（Markdown 技能） */
export interface Skill {
  name: string
  description: string
  author: string
  version: string
  triggers: string[]
  tags: string[]
  /** 是否启用，后端持久化；未返回时默认 true */
  enabled?: boolean
  /** 运行时实际是否生效 */
  effective_enabled?: boolean
  /** 配置变更是否需要重启 */
  requires_restart?: boolean
  /** 后端返回的状态说明 */
  message?: string
}

/** ClawHub 技能市场的 Skill */
export interface ClawHubSkill {
  name: string
  description: string
  author: string
  version: string
  tags: string[]
  downloads: number
  category: 'coding' | 'research' | 'writing' | 'data' | 'automation' | 'productivity'
}

export interface SkillStatusUpdateResult {
  success: boolean
  enabled: boolean
  effective_enabled?: boolean
  requires_restart?: boolean
  message?: string
  source: 'backend' | 'local-fallback'
}
