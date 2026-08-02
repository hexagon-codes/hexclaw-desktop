/**
 * Projects source facts without fabricating a printed question number. This
 * presentation kernel is shared by progressive, result, and overlay surfaces.
 */
export interface K12QuestionSourceDisplay {
  display_label?: string
  source_section_label?: string
  system_display_label?: string
}

export function k12QuestionSourceDisplayLabel(question: K12QuestionSourceDisplay): string {
  const section = question.source_section_label?.trim() ?? ''
  const item = question.display_label?.trim() || question.system_display_label?.trim() || ''
  if (section && item) return `${section} · ${item}`
  return section || item
}
