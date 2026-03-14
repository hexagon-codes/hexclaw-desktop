/** 后端返回的 Skill（Markdown 技能） */
export interface Skill {
  name: string
  description: string
  author: string
  version: string
  triggers: string[]
  tags: string[]
}
