/**
 * Team API
 *
 * 团队协作 — 共享 Agent 配置、团队成员管理、导入导出。
 * 优先使用后端 API，降级到 localStorage。
 */

import { apiGet, apiPost, apiDelete } from './client'
import {
  TEAM_DEFAULT_MEMBER,
  TEAM_FALLBACK_WARNINGS,
  TEAM_PENDING_MEMBER_LAST_ACTIVE,
} from '@/config/team-fallback'
import { logger } from '@/utils/logger'

// ─── 类型定义 ────────────────────────────────────────

export interface SharedAgent {
  id: string
  name: string
  author: string
  description: string
  downloads: number
  visibility: 'public' | 'team' | 'private'
  updated_at: string
  config?: Record<string, unknown>
}

export interface TeamMember {
  id: string
  name: string
  email: string
  role: 'admin' | 'member' | 'viewer'
  avatar?: string
  last_active: string
}

export interface TeamInvite {
  email: string
  role: 'member' | 'viewer'
}

// ─── localStorage 降级存储 ───────────────────────────

const SHARED_AGENTS_KEY = 'hexclaw_shared_agents'
const TEAM_MEMBERS_KEY = 'hexclaw_team_members'

function getLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function setLocal<T>(key: string, data: T) {
  localStorage.setItem(key, JSON.stringify(data))
}

// ─── 默认当前用户（桌面端单用户） ─────────────────────

function defaultMember(): TeamMember {
  return { ...TEAM_DEFAULT_MEMBER }
}

// ─── 共享 Agent API ──────────────────────────────────

export async function getSharedAgents(): Promise<SharedAgent[]> {
  try {
    const res = await apiGet<{ agents: SharedAgent[] }>('/api/v1/team/agents')
    return res.agents ?? []
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.getSharedAgents, e)
    return getLocal<SharedAgent[]>(SHARED_AGENTS_KEY, [])
  }
}

export async function shareAgent(agent: Omit<SharedAgent, 'id' | 'downloads' | 'updated_at'>): Promise<SharedAgent> {
  const now = new Date().toISOString()
  const newAgent: SharedAgent = {
    ...agent,
    id: `sa-${crypto.randomUUID().slice(0, 8)}`,
    downloads: 0,
    updated_at: now,
  }

  try {
    return await apiPost<SharedAgent>('/api/v1/team/agents', newAgent)
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.shareAgent, e)
    const agents = getLocal<SharedAgent[]>(SHARED_AGENTS_KEY, [])
    agents.push(newAgent)
    setLocal(SHARED_AGENTS_KEY, agents)
    return newAgent
  }
}

export async function deleteSharedAgent(id: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/team/agents/${encodeURIComponent(id)}`)
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.deleteSharedAgent, e)
    const agents = getLocal<SharedAgent[]>(SHARED_AGENTS_KEY, []).filter(a => a.id !== id)
    setLocal(SHARED_AGENTS_KEY, agents)
  }
}

// ─── 团队成员 API ────────────────────────────────────

export async function getTeamMembers(): Promise<TeamMember[]> {
  try {
    const res = await apiGet<{ members: TeamMember[] }>('/api/v1/team/members')
    return res.members ?? []
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.getTeamMembers, e)
    const local = getLocal<TeamMember[]>(TEAM_MEMBERS_KEY, [])
    if (local.length === 0) return [defaultMember()]
    return local
  }
}

export async function inviteTeamMember(invite: TeamInvite): Promise<TeamMember> {
  const member: TeamMember = {
    id: `tm-${crypto.randomUUID().slice(0, 8)}`,
    name: invite.email.split('@')[0] || invite.email,
    email: invite.email,
    role: invite.role,
    last_active: TEAM_PENDING_MEMBER_LAST_ACTIVE,
  }

  try {
    return await apiPost<TeamMember>('/api/v1/team/members', invite)
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.inviteTeamMember, e)
    const members = getLocal<TeamMember[]>(TEAM_MEMBERS_KEY, [defaultMember()])
    members.push(member)
    setLocal(TEAM_MEMBERS_KEY, members)
    return member
  }
}

export async function removeTeamMember(id: string): Promise<void> {
  try {
    await apiDelete(`/api/v1/team/members/${encodeURIComponent(id)}`)
  } catch (e) {
    logger.warn(TEAM_FALLBACK_WARNINGS.removeTeamMember, e)
    const members = getLocal<TeamMember[]>(TEAM_MEMBERS_KEY, []).filter(m => m.id !== id)
    setLocal(TEAM_MEMBERS_KEY, members)
  }
}

// ─── 导入导出 ────────────────────────────────────────

export interface ExportBundle {
  version: string
  exported_at: string
  agents: SharedAgent[]
  workflows?: unknown[]
  skills?: unknown[]
}

/** 导出全部配置 */
export async function exportAllConfig(): Promise<ExportBundle> {
  const agents = await getSharedAgents()
  return {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    agents,
  }
}

/** 导入配置 */
export async function importConfig(bundle: ExportBundle): Promise<{ imported: number }> {
  let imported = 0
  for (const agent of bundle.agents || []) {
    await shareAgent({
      name: agent.name,
      author: agent.author,
      description: agent.description,
      visibility: agent.visibility,
      config: agent.config,
    })
    imported++
  }
  return { imported }
}
