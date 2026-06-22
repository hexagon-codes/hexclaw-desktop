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
  /** SKILL.md frontmatter `icon`：emoji（如 "📊"）或内置 lucide 名（如 "Code"）。
   *  缺省时前端按 category/tags/name 派生稳定图标，故为可选——不破坏 SKILL.md 可移植性。 */
  icon?: string
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
  /** 同 Skill.icon：emoji 或内置 lucide 名；缺省时前端派生。 */
  icon?: string
  /** Hub 原始分类（coding/research/.../education/media/automotive 等，保持后端原值，前端按精选 pill 映射过滤） */
  category: string
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
