/**
 * 存量会话标题自愈（BUG-20260712 治本终章）
 *
 * 背景：会话标题曾以「运行时反查」设计存内部名（如 k12-tutor-xxx），渲染时查 agent 换显示名——
 * agent 一删，可读名随之蒸发，只剩「已删除的智能体」泛化兜底（信息已销毁，无从恢复）。
 * 治本（BUG-20260711）已让**新会话**建会话即快照显示名；本模块补齐**存量**：趁 agent 还活着，
 * 把内部名标题一次性落库为显示名（运行时反查 → 持久快照），并补写 session→agent 绑定，
 * 让未来的删除走墓碑链路（session-agent-binding），孤儿信号不再依赖名字形状启发式。
 *
 * 语义边界：
 *  - 只动「标题恰为某存活 agent 内部名」的会话——自定义标题是用户资产，绝不触碰；
 *  - display_name 为空则跳过（快照无意义）；
 *  - 落库失败不改本地（否则重启回退且永失自愈机会），下次启动自然重试；
 *  - 幂等：愈后标题=显示名，不再命中条件。
 */
import { updateSessionTitle } from '@/api/chat'
import { bindSessionAgent, getSessionAgent } from './session-agent-binding'
import { logger } from '@/utils/logger'
import type { ChatSession } from '@/types'

export interface HealAgentLookup {
  (name: string): { name: string; display_name?: string } | undefined
}

// 防并发重入（BUG-20260712-K：触发改为数据就绪驱动的 watcher 后，列表/agents 抖动可能
// 连续触发）：进行中直接跳过——自愈幂等，下次数据变化自然再触发。
let healInFlight = false

/** 对给定会话列表执行一轮自愈；返回成功愈合条数。best-effort，永不抛错。 */
export async function healLegacySessionTitles(
  sessions: ChatSession[],
  findAgent: HealAgentLookup,
): Promise<number> {
  if (healInFlight) return 0
  healInFlight = true
  try {
    return await healPass(sessions, findAgent)
  } finally {
    healInFlight = false
  }
}

async function healPass(sessions: ChatSession[], findAgent: HealAgentLookup): Promise<number> {
  let healed = 0
  for (const s of sessions) {
    const raw = (s.title ?? '').trim()
    if (!raw) continue
    const cfg = findAgent(raw)
    const display = (cfg?.display_name ?? '').trim()
    if (!cfg || !display || display === raw) continue
    try {
      await updateSessionTitle(s.id, display)
      s.title = display // 落库成功才改本地（失败保留内部名，下次启动重试）
      healed++
    } catch (e) {
      logger.warn('[session-title-heal] 标题自愈落库失败（下次启动重试）', s.id, e)
      continue
    }
    // 关联持久化（已有绑定不覆盖——绑定是权威关联，标题只是显示资产）
    if (!getSessionAgent(s.id)) bindSessionAgent(s.id, cfg.name)
  }
  return healed
}
