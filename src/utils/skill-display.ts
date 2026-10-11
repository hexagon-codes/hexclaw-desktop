import type { SkillContextReceipt, SkillDisplayMetadata, SkillTeachingMethod } from '@/types/skill'

/** 仅使用该条元数据的明确译名；同名标识不触发内置目录覆盖。 */
export function skillDisplayName(skill: SkillDisplayMetadata, locale: string): string {
  const language = locale === 'zh' ? 'zh-CN' : locale
  return skill.display_names?.[language]?.trim() || skill.display_name?.trim() || skill.name
}

/** 方法结构缺少当前语言时保留已声明原文，不运行临时翻译。 */
export function skillMethodStructure(text: Record<string, string>, locale: string): string {
  const language = locale === 'zh' ? 'zh-CN' : locale
  return text[language]?.trim() || text['zh-CN']?.trim() || text.en?.trim() || Object.values(text).find(value => value.trim()) || ''
}

function localeText(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')
}

function displayMetadata(value: Record<string, unknown>): boolean {
  return typeof value.name === 'string' && !!value.name.trim() &&
    (value.display_name === undefined || typeof value.display_name === 'string') &&
    (value.display_names === undefined || localeText(value.display_names))
}

/** 只读服务端持久快照；挂载名称、当前目录和缺失回执均不能补造历史依据。 */
export function skillContextReceipts(raw: unknown): (SkillContextReceipt & { methods: SkillTeachingMethod[] })[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((value): value is SkillContextReceipt & { methods: SkillTeachingMethod[] } => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const receipt = value as Record<string, unknown>
    return displayMetadata(receipt) && receipt.status === 'loaded' &&
      typeof receipt.version === 'string' && !!receipt.version.trim() &&
      typeof receipt.content_digest === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(receipt.content_digest) &&
      Array.isArray(receipt.methods) && receipt.methods.every(method => {
        if (!method || typeof method !== 'object' || Array.isArray(method)) return false
        const entry = method as Record<string, unknown>
        return displayMetadata(entry) && localeText(entry.structure)
      })
  })
}
