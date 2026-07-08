/**
 * 作业辅导助手·场景包 manifest（features/k12）——模板默认 skill 的**单一真相源**。
 *
 * 产品准则（产品评审定稿）：
 * - 默认 skill 随模板全挂好（帮家长预选，不让家长主动勾选）；
 * - 顶层只读展示为「能力」（人话，见 k12.profile.skills），非技术名清单；
 * - 原始 skill 清单收进「高级」折叠，可微调；P0 为必备底线（锁定不可关）。
 * - 后端 pack 应 embed/seed **同名 skill**（离线出厂），建档时即时绑定、零下载。
 */
export type SkillTier = 'P0' | 'P1' | 'P2'

export interface K12SkillDecl {
  /** skill slug（与 hexclaw-hub / 后端 pack seed 同名） */
  name: string
  /** 高级清单里的显示名 i18n key */
  labelKey: string
  icon: string
  /**
   * P0 必备底线（锁定，默认开不可关）｜P1 默认开可关｜P2 默认关可开（初中/按需）
   */
  tier: SkillTier
}

/** 模板声明的技能全集（高级折叠里逐项展示 + 微调） */
export const K12_TEMPLATE_SKILLS: K12SkillDecl[] = [
  { name: 'k12-pedagogy', labelKey: 'k12.manifest.pedagogy', icon: '🎓', tier: 'P0' },
  { name: 'homework-checker', labelKey: 'k12.manifest.homework', icon: '📷', tier: 'P0' },
  { name: 'math-tutor', labelKey: 'k12.manifest.math', icon: '🧮', tier: 'P0' },
  { name: 'chinese-tutor', labelKey: 'k12.manifest.chinese', icon: '📖', tier: 'P1' },
  { name: 'english-tutor', labelKey: 'k12.manifest.english', icon: '🔤', tier: 'P1' },
  { name: 'concept-explainer', labelKey: 'k12.manifest.concept', icon: '💡', tier: 'P1' },
  { name: 'exercise-generator', labelKey: 'k12.manifest.exercise', icon: '✏️', tier: 'P1' },
  { name: 'physics-tutor', labelKey: 'k12.manifest.physics', icon: '⚛️', tier: 'P2' },
  { name: 'chemistry-tutor', labelKey: 'k12.manifest.chemistry', icon: '🧪', tier: 'P2' },
]

/**
 * 基础设施 skill（非用户面、随模板必带、不进高级 toggle、家长不可关）：
 * - grade-constraint = 年级边界硬约束基座（Markdown，正文注入 system prompt）。所有 tutor 的
 *   「不超纲」红线话术源；引擎不按 requires co-load，必须显式挂载才注入（否则超纲替代话术 runtime 缺失）。
 * - k12_grade  = 批改闭环 engine 工具：LLM 调它跑解题验算+批改+错题入库（实例 scope 从 ctx 取）。
 * - k12_review = 复习飞轮读侧 engine 工具：取到期错题+陪练方案（对称 k12_grade，让复习在对话/IM 可达）。
 */
export const K12_INFRA_SKILLS: string[] = ['grade-constraint', 'k12_grade', 'k12_review']

/** 必备底线（锁定不可关） */
export function isRequiredSkill(name: string): boolean {
  return K12_TEMPLATE_SKILLS.some((s) => s.name === name && s.tier === 'P0')
}

/** 默认勾选集（P0 + P1；P2 默认关） */
export function defaultBoundSkills(): string[] {
  return K12_TEMPLATE_SKILLS.filter((s) => s.tier !== 'P2').map((s) => s.name)
}
