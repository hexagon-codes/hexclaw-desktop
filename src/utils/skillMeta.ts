/**
 * skillMeta — SkillMeta 构建工具
 *
 * 消除 skillLoader、skillRegistry、skillBridge、agentExecutor 中
 * 重复的 SkillMeta 内联构建逻辑。
 */

import type { SkillMeta } from '@/types'

/**
 * 从 skill.json 解析结果构建 SkillMeta。
 *
 * @param skillId — skill 目录名
 * @param parsed — 解析后的 skill.json 内容
 * @param source — skill 来源（默认 'custom'）
 * @returns SkillMeta 对象
 */
export function buildSkillMeta(
  skillId: string,
  parsed: Record<string, unknown>,
  source: SkillMeta['source'] = 'custom',
): SkillMeta {
  return {
    skillId,
    displayName: parsed.display_name ?? parsed.name ?? skillId,
    version: parsed.version ?? '0.0.0',
    description: parsed.description ?? '',
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    entry: parsed.entry ?? 'SKILL.md',
    path: `skills/${skillId}`,
    source,
  }
}
