export const TEAM_DEFAULT_MEMBER = {
  id: 'self',
  name: '当前用户',
  email: 'user@local',
  role: 'admin' as const,
  last_active: '在线',
}

export const TEAM_PENDING_MEMBER_LAST_ACTIVE = '待加入'

export const TEAM_FALLBACK_WARNINGS = {
  getSharedAgents: 'Team API unavailable, falling back to localStorage',
  shareAgent: 'shareAgent API unavailable, falling back to localStorage',
  deleteSharedAgent: 'deleteSharedAgent API unavailable, falling back to localStorage',
  getTeamMembers: 'getTeamMembers API unavailable, falling back to localStorage',
  inviteTeamMember: 'inviteTeamMember API unavailable, falling back to localStorage',
  removeTeamMember: 'removeTeamMember API unavailable, falling back to localStorage',
} as const
