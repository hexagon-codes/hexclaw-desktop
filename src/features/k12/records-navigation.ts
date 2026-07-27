export type K12RecordsTarget = 'week' | 'mistakes' | 'practiceSets' | 'accumulation' | 'works'

export type K12MistakeStatusFilter = 'all' | 'scheduled' | 'mastered' | 'suppressed'

/**
 * 学情与场景能力入口的档案导航命令。
 * subject/status 始终显式携带，保证每次下钻都能清理非目标筛选维度。
 */
export interface K12RecordsNavigation {
  target: K12RecordsTarget
  subject: string
  status: K12MistakeStatusFilter
}
