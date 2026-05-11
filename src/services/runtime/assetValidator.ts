/**
 * AssetValidator — Asset 路径安全校验
 *
 * Phase 9 仅做 3 项：
 * 1. normalize — 解析 . 和 ..
 * 2. traversal detection — 检测路径穿越（.. 逃逸）
 * 3. absolute path validation — 必须是绝对路径
 *
 * 不做：allowed-root policy / sandbox / workspace whitelist
 */

export interface ValidationResult {
  valid: boolean
  normalizedPath?: string
  error?: string
}

/**
 * 校验资产文件路径。
 *
 * 规则：
 * - 必须是绝对路径
 * - normalize 后不包含 .. 穿越段
 * - normalize 后不含 . 段
 */
export function validatePath(path: string): ValidationResult {
  if (!path || path.trim().length === 0) {
    return { valid: false, error: 'Path is empty' }
  }

  // 1. absolute path check
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')
  if (!isAbsolute) {
    return { valid: false, error: 'Path must be absolute' }
  }

  // 2. normalize — resolve . and ..
  const segments = path.replace(/\\/g, '/').split('/')
  const normalized: string[] = []

  for (const seg of segments) {
    if (seg === '' || seg === '.') {
      continue
    }
    if (seg === '..') {
      // traversal detection: if we can't pop, it's an escape
      if (normalized.length === 0 || normalized[normalized.length - 1] === '..') {
        return { valid: false, error: 'Path traversal detected' }
      }
      normalized.pop()
      continue
    }
    normalized.push(seg)
  }

  const normalizedPath = path.startsWith('/')
    ? '/' + normalized.join('/')
    : normalized.join('/')

  // 3. re-check: normalized path must still be recognizable as absolute
  const winMatch = normalizedPath.match(/^([a-zA-Z]):(.*)$/)
  if (winMatch) {
    const drive = winMatch[1]
    const rest = winMatch[2]
    if (!rest || rest === '') {
      return { valid: false, error: 'Path resolves to drive root — rejected' }
    }
    // Reconstruct Windows path with backslashes
    return { valid: true, normalizedPath: `${drive}:\\${rest.replace(/\//g, '\\').replace(/^\\/, '')}` }
  }

  if (normalizedPath === '/' || normalizedPath === '') {
    return { valid: false, error: 'Path resolves to root — rejected' }
  }

  return { valid: true, normalizedPath }
}
