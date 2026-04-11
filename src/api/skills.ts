import { apiGet, apiPost, apiPut, apiDelete } from './client'
import { MOCK_SKILLS } from '@/config/skills-marketplace'
import type { Skill, ClawHubSkill, SkillStatusUpdateResult } from '@/types'

export type { Skill, ClawHubSkill, SkillStatusUpdateResult }

/** 获取已安装 Skill 列表 */
export function getSkills() {
  return apiGet<{ skills: Skill[]; total: number; dir: string }>('/api/v1/skills')
}

export type SkillInstallType = 'file' | 'url' | 'clawhub'

interface SkillInstallResult {
  name: string
  description?: string
  version?: string
  message: string
}

/** 安装 Skill — 支持本地文件、URL、ClawHub 三种来源 */
export function installSkill(source: string, type?: SkillInstallType) {
  return apiPost<SkillInstallResult>(
    '/api/v1/skills/install',
    { source, type },
  )
}

/** 卸载 Skill */
export function uninstallSkill(name: string) {
  return apiDelete(`/api/v1/skills/${encodeURIComponent(name)}`)
}

/** 启用/禁用 Skill（优先以后端状态为准，缺失时降级到本地偏好） */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillStatusUpdateResult> {
  try {
    const result = await apiPut<Partial<SkillStatusUpdateResult>>(
      `/api/v1/skills/${encodeURIComponent(name)}/status`,
      { enabled },
    )
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

const HUB_CATEGORIES = [
  'coding',
  'research',
  'writing',
  'data',
  'automation',
  'productivity',
] as const

function normalizeHubCategory(raw: unknown): ClawHubSkill['category'] {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  if (HUB_CATEGORIES.includes(s as (typeof HUB_CATEGORIES)[number])) {
    return s as ClawHubSkill['category']
  }
  return 'coding'
}

function mapHubMetaToClawHubSkill(m: Record<string, unknown>): ClawHubSkill {
  return {
    name: String(m.name ?? ''),
    display_name: typeof m.display_name === 'string' ? m.display_name : undefined,
    description: String(m.description ?? ''),
    author: String(m.author ?? ''),
    version: String(m.version ?? ''),
    tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
    downloads: typeof m.downloads === 'number' ? m.downloads : 0,
    rating: typeof m.rating === 'number' ? m.rating : undefined,
    category: normalizeHubCategory(m.category),
  }
}

function isSkillHubEntry(m: Record<string, unknown>): boolean {
  const type = typeof m.type === 'string' ? m.type.toLowerCase().trim() : ''
  return type === '' || type === 'skill'
}

/** 搜索 ClawHub 技能市场（仅在显式 FORCE_MOCK 时降级到内置 Mock） */
export async function searchClawHub(
  query?: string,
  category?: string,
): Promise<ClawHubSkill[]> {
  if (CLAWHUB_FORCE_MOCK) {
    return filterMockSkills(query, category)
  }

  const q: Record<string, unknown> = {}
  if (query) q.q = query
  if (category && category !== 'all') q.category = category
  q.type = 'skill'

  // 共享 ClawHub 搜索端点（同 mcp.ts searchMcpMarketplace）
  const res = await apiGet<{
    skills?: unknown[]
    error?: string
  }>('/api/v1/clawhub/search', q)

  if (typeof res.error === 'string' && res.error.trim() !== '') {
    throw new Error(res.error.trim())
  }

  const raw = Array.isArray(res) ? res : Array.isArray(res.skills) ? res.skills : []
  return (raw as Record<string, unknown>[])
    .filter(isSkillHubEntry)
    .map(mapHubMetaToClawHubSkill)
}

/** 从 ClawHub 安装 Skill */
export async function installFromHub(skillName: string): Promise<void> {
  await apiPost('/api/v1/skills/install', {
    source: `clawhub://${skillName}`,
  })
}
