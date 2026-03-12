/** Skill 定义 */
export interface Skill {
  id: string
  name: string
  display_name: string
  description: string
  version: string
  author: string
  category: string
  enabled: boolean
  installed: boolean
  config?: Record<string, unknown>
}
