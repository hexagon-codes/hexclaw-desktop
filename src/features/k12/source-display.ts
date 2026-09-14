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

/** 兼容识题历史纯公式未带定界符的展示；不改写服务端原题及确认载荷。 */
export function k12MathDisplayMarkdown(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      if (/\$|\\[()[\]]/.test(line)) return line
      if (!/\\(?:frac|dfrac|tfrac|times|div|cdot|sqrt)\b/.test(line)) return line
      // 只为完整数学片段补定界符；中文题干、原始作答标签与其他正文保持原位。
      return line.replace(
        /(?:\\(?:frac|dfrac|tfrac|times|div|cdot|sqrt)|[0-9{}().+\-*/=^_\s×÷−])+/g,
        (part) =>
          /\\(?:frac|dfrac|tfrac|times|div|cdot|sqrt)\b/.test(part)
            ? `${part.match(/^\s*/)?.[0] ?? ''}$${part.trim()}$${part.match(/\s*$/)?.[0] ?? ''}`
            : part,
      )
    })
    .join('\n')
}
