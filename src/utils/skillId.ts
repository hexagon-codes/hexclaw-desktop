/**
 * skillId — 共享 skillId 净化工具
 *
 * 职责：
 * - 统一 skillId 的净化逻辑（小写、剥离非法字符、检测路径穿越）
 * - 返回净化后的字符串，空字符串表示非法输入
 *
 * 使用场景：
 * - SkillRegistry：目录迭代中跳过非法 skillId（返回空 → continue）
 * - SkillLoader：已知 skillId 场景，非法输入抛出错误
 * - SkillBridge：fallback 包构建
 */

const VALID_SKILL_ID_RE = /[^a-z0-9_-]/g

/**
 * 净化 skillId：小写化 + 剥离非法字符 + 检测路径穿越。
 *
 * @param id — 原始 skillId
 * @returns 净化后的 skillId，空字符串表示非法输入
 */
export function sanitizeSkillId(id: string): string {
  const sanitized = id.toLowerCase().replace(VALID_SKILL_ID_RE, '')
  if (!sanitized || sanitized.startsWith('.') || sanitized.includes('..')) {
    return ''
  }
  return sanitized
}
