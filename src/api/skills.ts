import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Skill } from '@/types'

export type { Skill }

/** 获取已安装 Skill 列表 */
export function getSkills() {
  return apiGet<{ skills: Skill[] }>('/api/v1/skills')
}

/** 安装 Skill */
export function installSkill(name: string) {
  return apiPost<Skill>('/api/v1/skills/install', { name })
}

/** 卸载 Skill */
export function uninstallSkill(id: string) {
  return apiDelete(`/api/v1/skills/${id}`)
}

/** 启用/禁用 Skill */
export function toggleSkill(id: string, enabled: boolean) {
  return apiPut(`/api/v1/skills/${id}`, { enabled })
}

/** 更新 Skill 配置 */
export function updateSkillConfig(id: string, config: Record<string, unknown>) {
  return apiPut(`/api/v1/skills/${id}/config`, config)
}
