import type { SkillMeta } from './context'

/** 后端返回的 Skill（Markdown 技能） */
export interface Skill {
  id?: string
  name: string
  display_name?: string
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

/** ClawHub 技能市场的 Skill（与后端 hub.SkillMeta 对齐） */
export interface ClawHubSkill {
  name: string
  display_name?: string
  description: string
  author: string
  version: string
  tags: string[]
  downloads: number
  rating?: number
  category: 'coding' | 'research' | 'writing' | 'data' | 'automation' | 'productivity'
  /** 仅开发：CLAWHUB_FORCE_MOCK 时使用内置数据 */
  _mock?: boolean
}

export interface SkillStatusUpdateResult {
  success: boolean
  enabled: boolean
  effective_enabled?: boolean
  requires_restart?: boolean
  message?: string
  warning?: string
  source: 'backend' | 'local-fallback'
}

// ── Skill Package Format (Module 007) ────────────────

/** 层级声明（stable） */
export interface SkillLayer {
  id: string
  file: string
  trigger: string
  description?: string
  content?: string  // 加载后填充
}

/** 命令声明（stable，Claude Code 兼容） */
export interface SkillCommand {
  name: string
  file: string
  description?: string
  args?: Record<string, { type: string; required?: boolean; description?: string }>
}

/** 依赖声明（stable） */
export interface SkillDependencies {
  skills?: string[]
  runtime?: string[]
  tools?: string[]
}

/** 信任元数据（stable） */
export interface SkillTrust {
  source: 'clawhub' | 'github' | 'local' | 'claude-code'
  verified: boolean
  risk: 'low' | 'medium' | 'high'
}

/** 交互声明（experimental → Chat Workspace Runtime 消费） */
export interface SkillAction {
  id: string
  label: string
  intent: string
}

/** 沙盒模式 */
export type SandboxMode = 'restricted' | 'full'

/** 实验性子类型 */
export interface SkillAgent {
  name: string
  file: string
  description?: string
  model?: string
  tools?: string[]
}

export interface SkillHook {
  name: string
  file: string
  event: 'pre-task' | 'post-task' | 'pre-invoke' | 'post-invoke'
}

/** 实验性扩展（experimental，不承诺兼容） */
export interface SkillExperimental {
  scripts?: Record<string, { file: string; sandbox: SandboxMode }>
  hooks?: SkillHook[]
  agents?: SkillAgent[]
  interaction?: {
    actions?: SkillAction[]
  }
}

/** Runtime 兼容性声明 */
export interface SkillRuntimeCompat {
  min_version?: string
  engine?: string[]
  platform?: string[]
}

/** 完整 Skill Package 元数据（extends SkillMeta） */
export interface SkillPackageMeta extends SkillMeta {
  schema_version: string
  runtime?: SkillRuntimeCompat
  layers: SkillLayer[]
  commands?: SkillCommand[]
  dependencies?: SkillDependencies
  _trust?: SkillTrust
  experimental?: SkillExperimental
  author?: string
  license?: string
  tags?: string[]
}
