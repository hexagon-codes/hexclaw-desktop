import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Skill, ClawHubSkill, SkillStatusUpdateResult } from '@/types'

export type { Skill, ClawHubSkill, SkillStatusUpdateResult }

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
      success: false,
      enabled,
      message: error instanceof Error ? error.message : undefined,
      source: 'local-fallback',
    }
  }
}

// ─── ClawHub 技能市场 ──────────────────────────────────

/** 设为 true 强制使用内置 Mock 数据；false 时优先尝试真实 API，失败降级 */
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

/** Mock 数据 */
const MOCK_SKILLS: ClawHubSkill[] = [
  {
    name: 'code-review-pro',
    description: '自动化代码审查，支持多种语言的代码规范检查、安全漏洞扫描和性能优化建议',
    author: 'openclaw',
    version: '2.1.0',
    tags: ['code-review', 'security', 'lint'],
    downloads: 28430,
    category: 'coding',
  },
  {
    name: 'git-commit-craft',
    description: '根据 diff 自动生成符合 Conventional Commits 规范的提交信息',
    author: 'devtools-hub',
    version: '1.4.2',
    tags: ['git', 'commit', 'conventional'],
    downloads: 19200,
    category: 'coding',
  },
  {
    name: 'test-generator',
    description: '根据源代码自动生成单元测试，支持 Jest / Vitest / pytest / Go test',
    author: 'testcraft',
    version: '1.8.0',
    tags: ['testing', 'unit-test', 'tdd'],
    downloads: 15670,
    category: 'coding',
  },
  {
    name: 'arxiv-reader',
    description: '自动解析 arXiv 论文，提取关键信息、方法论和结论，生成结构化摘要',
    author: 'research-ai',
    version: '1.2.1',
    tags: ['arxiv', 'paper', 'summary'],
    downloads: 12840,
    category: 'research',
  },
  {
    name: 'web-researcher',
    description: '深度网络调研工具，自动搜索、汇总多个来源的信息并生成调研报告',
    author: 'openclaw',
    version: '2.0.3',
    tags: ['search', 'report', 'web'],
    downloads: 22100,
    category: 'research',
  },
  {
    name: 'fact-checker',
    description: '对 Agent 输出内容进行事实核查，交叉验证多个信息源',
    author: 'verify-ai',
    version: '1.0.5',
    tags: ['fact-check', 'verify', 'accuracy'],
    downloads: 8930,
    category: 'research',
  },
  {
    name: 'blog-writer',
    description: '根据主题和大纲生成高质量博客文章，支持 SEO 优化和多种写作风格',
    author: 'content-craft',
    version: '1.6.0',
    tags: ['blog', 'seo', 'content'],
    downloads: 17500,
    category: 'writing',
  },
  {
    name: 'doc-translator',
    description: '高质量文档翻译，保持格式和术语一致性，支持 30+ 语言',
    author: 'polyglot-ai',
    version: '2.3.1',
    tags: ['translation', 'i18n', 'docs'],
    downloads: 24600,
    category: 'writing',
  },
  {
    name: 'copywriting-pro',
    description: '营销文案生成，支持广告、社交媒体、邮件等多种场景',
    author: 'marketer-ai',
    version: '1.3.0',
    tags: ['copywriting', 'marketing', 'ad'],
    downloads: 11200,
    category: 'writing',
  },
  {
    name: 'csv-analyst',
    description: '自动分析 CSV/Excel 数据集，生成统计摘要、可视化图表和洞察报告',
    author: 'data-works',
    version: '1.5.2',
    tags: ['csv', 'analytics', 'visualization'],
    downloads: 13400,
    category: 'data',
  },
  {
    name: 'sql-assistant',
    description: '自然语言转 SQL 查询，支持 PostgreSQL / MySQL / SQLite 方言',
    author: 'dbtools',
    version: '2.0.0',
    tags: ['sql', 'database', 'query'],
    downloads: 20800,
    category: 'data',
  },
  {
    name: 'json-transformer',
    description: 'JSON 数据格式转换、清洗和验证工具，支持 JSONPath 和 Schema 校验',
    author: 'data-works',
    version: '1.1.3',
    tags: ['json', 'transform', 'schema'],
    downloads: 9700,
    category: 'data',
  },
  {
    name: 'cron-scheduler',
    description: '智能 Cron 任务编排，根据自然语言描述生成复杂的调度计划',
    author: 'ops-toolkit',
    version: '1.2.0',
    tags: ['cron', 'scheduler', 'ops'],
    downloads: 7600,
    category: 'automation',
  },
  {
    name: 'api-integrator',
    description: '快速集成第三方 API，自动生成请求代码和错误处理逻辑',
    author: 'openclaw',
    version: '1.7.1',
    tags: ['api', 'integration', 'http'],
    downloads: 16300,
    category: 'automation',
  },
  {
    name: 'file-organizer',
    description: '智能文件分类和整理，根据内容自动重命名、分类和归档',
    author: 'productivity-lab',
    version: '1.0.8',
    tags: ['files', 'organize', 'rename'],
    downloads: 10500,
    category: 'automation',
  },
  {
    name: 'meeting-notes',
    description: '会议记录整理和摘要生成，自动提取行动项和决议',
    author: 'productivity-lab',
    version: '1.4.0',
    tags: ['meeting', 'notes', 'summary'],
    downloads: 14200,
    category: 'productivity',
  },
  {
    name: 'email-composer',
    description: '智能邮件撰写助手，根据上下文生成专业的商务邮件',
    author: 'office-ai',
    version: '1.2.5',
    tags: ['email', 'business', 'compose'],
    downloads: 18700,
    category: 'productivity',
  },
  {
    name: 'daily-digest',
    description: '每日信息汇总，自动收集和整理来自多个渠道的更新和通知',
    author: 'productivity-lab',
    version: '1.1.0',
    tags: ['digest', 'news', 'daily'],
    downloads: 6800,
    category: 'productivity',
  },
]

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

/** 搜索 ClawHub 技能市场（默认优先真实 API；失败或空结果降级 Mock；开发可设 CLAWHUB_FORCE_MOCK） */
export async function searchClawHub(
  query?: string,
  category?: string,
): Promise<ClawHubSkill[]> {
  if (CLAWHUB_FORCE_MOCK) {
    return filterMockSkills(query, category)
  }

  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (category && category !== 'all') params.set('category', category)
  const qs = params.toString()

  try {
    const res = await apiGet<{
      skills?: unknown[]
      error?: string
    }>(`/api/v1/clawhub/search${qs ? '?' + qs : ''}`)

    if (typeof res.error === 'string' && res.error.trim() !== '') {
      return filterMockSkills(query, category)
    }

    const raw = Array.isArray(res) ? res : res.skills ?? []
    const mapped = (raw as Record<string, unknown>[]).map(mapHubMetaToClawHubSkill)
    if (mapped.length === 0) {
      return filterMockSkills(query, category)
    }
    return mapped
  } catch {
    return filterMockSkills(query, category)
  }
}

/** 从 ClawHub 安装 Skill */
export async function installFromHub(skillName: string): Promise<void> {
  await apiPost('/api/v1/skills/install', {
    source: `clawhub://${skillName}`,
  })
}
