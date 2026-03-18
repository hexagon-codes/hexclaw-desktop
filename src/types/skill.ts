/** 后端返回的 Skill（Markdown 技能） */
export interface Skill {
  name: string
  description: string
  author: string
  version: string
  triggers: string[]
  tags: string[]
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
