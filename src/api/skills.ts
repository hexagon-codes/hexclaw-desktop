import { invoke } from '@tauri-apps/api/core'
import { MOCK_SKILLS } from '@/config/skills-marketplace'
import type { Skill, ClawHubSkill, SkillStatusUpdateResult } from '@/types'

export type { Skill, ClawHubSkill, SkillStatusUpdateResult }

/** 获取已安装 Skill 列表（通过 Tauri 代理请求） */
export async function getSkills() {
  const { apiGet } = await import('./client')
  return apiGet<{ skills: Skill[]; total: number; dir: string }>('/api/v1/skills')
}

export type SkillInstallType = 'file' | 'url' | 'clawhub'

interface SkillInstallResult {
  name: string
  description?: string
  version?: string
  message: string
}

/** 安装 Skill — 支持本地文件、URL、ClawHub 三种来源（通过 Tauri command） */
export async function installSkill(source: string, type?: SkillInstallType): Promise<SkillStatusUpdateResult> {
  try {
    const result = await invoke<{
      success: boolean
      enabled?: boolean
      effective_enabled?: boolean
      requires_restart?: boolean
      message?: string
      name?: string
      description?: string
      version?: string
    }>('skill_install', { source, skillType: type })

    return {
      success: result.success,
      enabled: result.enabled ?? true,
      effective_enabled: result.effective_enabled,
      requires_restart: result.requires_restart,
      message: result.message ?? (result.name ? `${result.name} installed successfully` : undefined),
      source: 'backend',
    }
  } catch (error) {
    return {
      success: false,
      enabled: false,
      message: error instanceof Error ? error.message : String(error),
      source: 'backend',
    }
  }
}

/** 卸载 Skill（通过 Tauri command） */
export async function uninstallSkill(name: string): Promise<SkillStatusUpdateResult> {
  try {
    const result = await invoke<{
      success: boolean
      message?: string
    }>('skill_uninstall', { name })

    return {
      success: result.success,
      enabled: false,
      message: result.message ?? `${name} uninstalled successfully`,
      source: 'backend',
    }
  } catch (error) {
    return {
      success: false,
      enabled: false,
      message: error instanceof Error ? error.message : String(error),
      source: 'backend',
    }
  }
}

/** 启用/禁用 Skill（通过 Tauri command，优先以后端状态为准） */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillStatusUpdateResult> {
  try {
    const result = await invoke<{
      success: boolean
      enabled?: boolean
      effective_enabled?: boolean
      requires_restart?: boolean
      message?: string
    }>('skill_set_enabled', { name, enabled })

    return {
      success: true,
      enabled: typeof result.enabled === 'boolean' ? result.enabled : enabled,
      effective_enabled: typeof result.effective_enabled === 'boolean' ? result.effective_enabled : undefined,
      requires_restart: typeof result.requires_restart === 'boolean' ? result.requires_restart : undefined,
      message: typeof result.message === 'string' ? result.message : undefined,
      source: 'backend',
    }
  } catch (error) {
    return {
      success: true,
      enabled,
      warning: 'Backend unreachable; applied locally only and may revert on restart.',
      message: error instanceof Error ? error.message : undefined,
      source: 'local-fallback',
    }
  }
}

// ─── ClawHub 技能市场 ──────────────────────────────────

/** 设为 true 强制使用内置 Mock 数据；false 时仅使用真实 API */
const CLAWHUB_FORCE_MOCK = false

/** ClawHub 分类 → 中文映射 */
export const CLAWHUB_CATEGORIES = [
  'all',
  'coding',
  'research',
  'writing',
  'data',
  'automation',
  'productivity',
] as const

export type ClawHubCategory = (typeof CLAWHUB_CATEGORIES)[number]

/** 本地过滤 Mock 数据（标记 _mock 以区分真实 Hub 数据） */
function filterMockSkills(query?: string, category?: string): ClawHubSkill[] {
  let results = [...MOCK_SKILLS]
  if (category && category !== 'all') {
    results = results.filter((s) => s.category === category)
  }
  if (query) {
    const q = query.toLowerCase()
    results = results.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.author.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }
  return results.map((s) => ({ ...s, _mock: true }))
}

/** 搜索 ClawHub 技能市场（通过 Tauri command） */
export async function searchClawHub(
  query?: string,
  category?: string,
): Promise<ClawHubSkill[]> {
  if (CLAWHUB_FORCE_MOCK) {
    return filterMockSkills(query, category)
  }

  try {
    const skills = await invoke<Array<{
      name: string
      display_name?: string
      description: string
      author: string
      version: string
      tags: string[]
      downloads?: number
      rating?: number
      category: string
    }>>('skill_search', { query, category })

    return skills.map((s) => ({
      name: s.name,
      display_name: s.display_name,
      description: s.description,
      author: s.author,
      version: s.version,
      tags: s.tags,
      downloads: s.downloads ?? 0,
      rating: s.rating,
      category: s.category as ClawHubSkill['category'],
    }))
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** 从 ClawHub 安装 Skill（通过 Tauri command） */
export async function installFromHub(skillName: string): Promise<void> {
  const result = await installSkill(`clawhub://${skillName}`, 'clawhub')
  if (!result.success) {
    throw new Error(result.message ?? `Failed to install ${skillName}`)
  }
}
