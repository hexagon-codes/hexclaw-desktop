/**
 * K12 年级 / 教材枚举（features/k12）。
 * 当前能力范围仅小学（架构 §1.3 v0.5.0 / K12-INV-014：不暴露初中、高中）。
 * UI 将年级与学期作为两个独立选择器；领域/API 仍使用既有 `一年级上`~`六年级下`
 * grade_term 契约。冻结锁 bug-20260718-frozen-grade-subject。
 * 下列 value 是**后端契约**，不做 i18n；仅 HcSelect 的 label 由各语言资源提供。
 */
export const PRIMARY_GRADES = [
  '一年级',
  '二年级',
  '三年级',
  '四年级',
  '五年级',
  '六年级',
] as const

export type PrimaryGrade = (typeof PRIMARY_GRADES)[number]

// Roadmap-only options for the shared HcSelect. Keeping them outside PRIMARY_GRADES
// guarantees that unsupported grades cannot enter the persisted grade_term contract.
export const FUTURE_GRADE_OPTIONS = [
  { value: 'future-junior-1', label: '初一 · 暂未开放', disabled: true },
  { value: 'future-junior-2', label: '初二 · 暂未开放', disabled: true },
  { value: 'future-junior-3', label: '初三 · 暂未开放', disabled: true },
  { value: 'future-senior-1', label: '高一 · 暂未开放', disabled: true },
  { value: 'future-senior-2', label: '高二 · 暂未开放', disabled: true },
  { value: 'future-senior-3', label: '高三 · 暂未开放', disabled: true },
] as const

export const SEMESTERS = ['上', '下'] as const

export type Semester = (typeof SEMESTERS)[number]

export type GradeTerm = `${PrimaryGrade}${Semester}`

export const GRADES: GradeTerm[] = PRIMARY_GRADES.flatMap((grade) =>
  SEMESTERS.map((semester) => `${grade}${semester}` as GradeTerm),
)

const DEFAULT_GRADE: PrimaryGrade = '五年级'
const DEFAULT_SEMESTER: Semester = '上'

/**
 * 既有 grade_term → 两个 UI 字段。
 * 所有受支持的 12 个契约值均无损拆分；历史异常值不外泄到受控下拉，回到建档默认。
 */
export function splitGradeTerm(value: string): {
  grade: PrimaryGrade
  semester: Semester
} {
  const semester = value.endsWith('下') ? '下' : value.endsWith('上') ? '上' : null
  const grade = value.slice(0, -1)
  if (semester && PRIMARY_GRADES.includes(grade as PrimaryGrade)) {
    return { grade: grade as PrimaryGrade, semester }
  }
  return { grade: DEFAULT_GRADE, semester: DEFAULT_SEMESTER }
}

/** 两个 UI 字段 → 既有 grade_term/API 串；不引入第二套持久化格式。 */
export function joinGradeTerm(grade: PrimaryGrade, semester: Semester): GradeTerm {
  return `${grade}${semester}`
}

/** 教材版本（首批人教版走通全链，北师大/苏教随 M3-3 扩展） */
export const TEXTBOOKS: string[] = ['人教版', '北师大版', '苏教版']

/** 年级学期 → 年级短名（去掉上/下，用于显示名，如 五年级上 → 五年级） */
export function gradeShort(grade: string): string {
  return grade.replace(/[上下]$/, '')
}
