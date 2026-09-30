export const INPUT_LIMITS = {
  displayName: 64,
  childName: 40,
  title: 200,
  description: 2000,
  keyword: 512,
  knowledgeQuery: 4096,
  schedule: 256,
  identifier: 256,
  urlBytes: 8192,
  secretBytes: 65536,
  jsonBytes: 1048576,
  chatBytes: 20971520,
} as const

export function inputLimitError(
  value: string,
  label: string,
  limit: number,
  options: { unit?: 'characters' | 'bytes'; original?: string } = {},
): string {
  // 旧值未变时允许保存其他配置，不把新规则追溯到存量内容。
  if (options.original !== undefined && value === options.original) return ''
  const bytes = options.unit === 'bytes'
  const length = bytes ? new TextEncoder().encode(value).byteLength : Array.from(value).length
  return length > limit ? `${label} must be ${limit} ${bytes ? 'bytes' : 'characters'} or fewer.` : ''
}
