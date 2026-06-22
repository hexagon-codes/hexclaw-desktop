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

/** 与 AI 对话生成一份 SKILL.md 草稿（仅生成，不落盘；预览/编辑后再 installSkillContent） */
export async function generateSkill(description: string): Promise<string> {
  const res = await apiPost<{ content: string }>('/api/v1/skills/generate', { description })
  return res.content ?? ''
}

/** 把（AI 生成或就地编辑后的）完整 SKILL.md 原文安装落盘 */
export function installSkillContent(content: string) {
  return apiPost<SkillInstallResult>('/api/v1/skills/install', { type: 'content', content })
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
    // 区分「后端明确业务拒绝(4xx，如 404 技能未安装 / 400 非法名称)」与「网络不可达」：
    // 只有当错误带有真实的 HTTP `response` 对象（后端确实回了 4xx）时，才如实回报失败，
    // 不能伪装成「已应用(本地)」误导用户写入无效状态。
    // 仅有裸 `status` 字段而无 `response`（多为客户端/网络层合成错误）时，
    // 不视为后端业务拒绝，仍走本地降级。
    const status = httpStatusOf(error)
    if (status !== undefined && status >= 400 && status < 500) {
      return {
        success: false,
        enabled,
        message: error instanceof Error ? error.message : undefined,
        source: 'backend',
      }
    }
    return {
      success: true,
      enabled,
      warning: 'Backend unreachable; applied locally only and may revert on restart.',
      message: error instanceof Error ? error.message : undefined,
      source: 'local-fallback',
    }
  }
}

/**
 * 从错误里抽取「后端真实 HTTP 响应」的状态码。
 * 仅认 `error.response.status`（ofetch 在收到后端响应时挂载），不认裸 `.status`/`.statusCode`——
 * 后者多为网络层/客户端合成错误，不代表后端做出了业务拒绝，应走本地降级而非如实报失败。
 */
function httpStatusOf(error: unknown): number | undefined {
  const e = error as { response?: { status?: number } } | null
  return e?.response?.status
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

/**
 * 保留 hub 原始分类（仅小写归一）。
 * 旧实现会把非标准分类（education/media/automotive…）一律压成 'coding'，
 * 会破坏前端按精选 pill 的客户端映射过滤，故改为透传原值；空值兜底 'coding'。
 */
function normalizeHubCategory(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  return s || 'coding'
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
    icon: typeof m.icon === 'string' ? m.icon : undefined,
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

/** 读取 ClawHub 某技能的 SKILL.md 原文（安装前预览，不落盘） */
export function getHubSkillContent(name: string) {
  return apiGet<{ name: string; content: string }>(
    `/api/v1/clawhub/skills/${encodeURIComponent(name)}/content`,
  )
}

/** 读取某个 Skill 的 SKILL.md 原文（只读查看；市场技能不支持就地编辑） */
export function getSkillContent(name: string) {
  return apiGet<{ name: string; path: string; content: string }>(
    `/api/v1/skills/${encodeURIComponent(name)}/content`,
  )
}
