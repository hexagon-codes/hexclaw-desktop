import type { ScenarioIdentityProjection } from '@/shell/scenario/registry'
import { K12_SCENARIO_ID } from './descriptor'

export type K12AssistantIdentityProjection = ScenarioIdentityProjection

function metadataText(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * K12 可见身份只从当前 Agent 档案派生。
 * generatedAliases 仅列出产品历史上自动生成过的名称，绝不扫描或替换任意“老师”文本。
 */
export function resolveK12AssistantIdentityProjection(
  metadata?: Record<string, unknown>,
): K12AssistantIdentityProjection | null {
  const scenario = metadataText(metadata, 'scenario') || metadataText(metadata, 'template')
  if (scenario !== K12_SCENARIO_ID) return null

  const childName = metadataText(metadata, 'k12.child_name')
  if (!childName) return null

  const gradeTerm = metadataText(metadata, 'k12.grade_term')
  const grade = gradeTerm.replace(/[上下](?:学期)?$/, '').trim()
  const assistantName = `${childName}的辅导助手`
  const legacyTeacherName = `${childName}的辅导老师`
  const displayName = grade ? `${assistantName} · ${grade}` : assistantName

  return {
    displayName,
    generatedAliases: [
      assistantName,
      displayName,
      legacyTeacherName,
      ...(grade ? [`${legacyTeacherName} · ${grade}`] : []),
    ],
  }
}

