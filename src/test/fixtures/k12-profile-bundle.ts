import type { AgentConfig } from '@/types'

/** 将既有档案用例的输入与各读取夹具组合成新的原子快照响应，不改变用例断言。 */
export function profileBundleFixture(
  agent: Partial<AgentConfig> | undefined,
  profile: { child_name?: string; grade_term?: string; revision?: number },
  progress: { progress?: unknown; revision?: number },
  settings: unknown,
) {
  const metadata = agent?.metadata ?? {}
  const defaults = { math: '人教版', chinese: '人教版', english: '人教PEP版', science: '教科版', information_technology: '浙教版', art: '人美版' }
  const subjects = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
    key, metadata[`k12.textbook_edition.${key}`] ?? (key === 'math' ? metadata['k12.textbook_edition'] : undefined) ?? value,
  ]))
  return {
    agent_config: {
      display_name: agent?.display_name ?? '', description: agent?.description ?? '',
      system_prompt: agent?.system_prompt ?? '', provider: agent?.provider ?? '',
      model: agent?.model ?? '', skills: agent?.skills ?? [],
    },
    profile: {
      child_name: metadata['k12.child_name'] ?? profile.child_name ?? '小明',
      grade_term: metadata['k12.grade_term'] ?? profile.grade_term ?? '五年级上',
      textbook_edition: subjects.math, subject_textbooks: subjects, revision: profile.revision ?? 0,
    },
    curriculum_progress: progress.progress ?? null, progress_revision: progress.revision ?? 0,
    weekly_practice_settings: settings, command: null,
  }
}
