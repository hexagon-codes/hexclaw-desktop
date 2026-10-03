import type { AgentConfig, CronJob } from '@/types'
import type { CronJobPresentation } from '@/shell/scenario/registry'
import { K12_SCENARIO_ID } from './descriptor'

const DEFAULT_TASK_NAMES = new Map([
  ['weekly-sheet', '错题卷（每周五）'],
  ['return-reminder', '回传提醒（每天）'],
  ['semester-spring', '学期确认（3/1）'],
  ['semester-fall', '学期确认（9/1）'],
])

/** 仅已确认稳定归属的默认任务参与投影；自定义任务名称保持原样。 */
export function resolveK12CronJobPresentation(
  job: CronJob,
  agents: readonly AgentConfig[],
): CronJobPresentation | null {
  const sourceKey = job.source_key
  if (!sourceKey) return null
  const separator = sourceKey.lastIndexOf('/')
  if (separator <= 0) return null
  const agentName = sourceKey.slice(0, separator)
  const taskName = DEFAULT_TASK_NAMES.get(sourceKey.slice(separator + 1))
  if (!taskName) return null
  const agent = agents.find((candidate) => candidate.name === agentName)
  if (!agent || agent.metadata?.scenario !== K12_SCENARIO_ID) return null
  const displayName = agent.display_name
  return {
    displayName:
      displayName?.trim() && job.name === `${taskName}·${agentName}`
        ? `${taskName}·${displayName}`
        : job.name,
    deleteNotice: '保存孩子档案会重新补齐默认任务',
  }
}
