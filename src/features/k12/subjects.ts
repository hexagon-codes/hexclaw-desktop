/**
 * 后端接受的批改学科，对齐架构 §1.3 v0.5.0 五学科口径（subject 取值权威 §4.11）：
 * 数学/语文/英语/科学/信息科技。物理/化学不在当前能力范围（K12-INV-014），已移除；
 * 美术进作品不进批改（subject 取值非法），故不在此列。冻结锁 bug-20260718-frozen-grade-subject。
 */
export const K12_GRADE_SUBJECT_OPTIONS = [
  {
    value: '数学',
    labelKey: 'k12.tutoringTips.subjectMath',
    plainLabelKey: 'k12.profile.subjects.math',
  },
  {
    value: '语文',
    labelKey: 'k12.tutoringTips.subjectChinese',
    plainLabelKey: 'k12.profile.subjects.chinese',
  },
  {
    value: '英语',
    labelKey: 'k12.tutoringTips.subjectEnglish',
    plainLabelKey: 'k12.profile.subjects.english',
  },
  {
    value: '科学',
    labelKey: 'k12.tutoringTips.subjectScience',
    plainLabelKey: 'k12.profile.subjects.science',
  },
  {
    value: '信息科技',
    labelKey: 'k12.tutoringTips.subjectInfoTech',
    plainLabelKey: 'k12.profile.subjects.informationTechnology',
  },
] as const
