import { apiGet, apiPost, apiDelete } from './client'
import type { Skill } from '@/types'

export type { Skill }

/** 获取已安装 Skill 列表 */
export function getSkills() {
  return apiGet<{ skills: Skill[]; total: number; dir: string }>('/api/v1/skills')
}

/** 安装 Skill（从本地路径） */
export function installSkill(source: string) {
  return apiPost<{ name: string; description: string; version: string; message: string }>(
    '/api/v1/skills/install',
    { source },
  )
}

/** 卸载 Skill */
export function uninstallSkill(name: string) {
  return apiDelete(`/api/v1/skills/${name}`)
}
