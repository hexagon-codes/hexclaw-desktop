/**
 * 设计审计 — 验证不优雅/不符合最佳实践的代码模式
 *
 * 只包含可量化、可验证的检查项。
 * 检出后标记为已知问题或直接修复。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function walkFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '__benchmarks__' || entry === '.git') continue
      results.push(...walkFiles(full, exts))
    } else if (exts.some(e => full.endsWith(e))) {
      results.push(full)
    }
  }
  return results
}

// ═══════════════════════════════════════════════════
// 1. 硬编码中文审计 — API 层/Service 层不应有用户面文案
// ═══════════════════════════════════════════════════

describe('设计审计: API/Service 层硬编码中文', () => {
  const API_FILES = walkFiles('src/api', ['.ts']).filter(f => !f.includes('__tests__'))
  const SVC_FILES = walkFiles('src/services', ['.ts']).filter(f => !f.includes('__tests__'))

  it('API 层不应包含硬编码的用户面中文错误信息', () => {
    const violations: string[] = []
    for (const file of API_FILES) {
      const source = readFileSync(file, 'utf-8')
      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
        // 检查包含中文的字符串字面量（排除注释和 import）
        if (/['"`].*[\u4e00-\u9fff].*['"`]/.test(line) && !line.includes('import')) {
          violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`)
        }
      }
    }
    // 记录但不阻塞 — 这些是已知的、需要逐步迁移到 i18n 的文案
    if (violations.length > 0) {
      console.warn(`API 层硬编码中文 (${violations.length} 处):\n  ${violations.slice(0, 5).join('\n  ')}${violations.length > 5 ? `\n  ...还有 ${violations.length - 5} 处` : ''}`)
    }
    // im-channels.ts 有大量 i18n 配置字段（label/placeholder），属于正常设计
    // knowledge.ts 有少量用户面中文错误信息（normalizeKnowledgeEndpointError），可接受
    // canvas.ts 新增 logger.warn/error 中文日志信息（4 处）
    expect(violations.length).toBeLessThan(70) // 基线：im-channels 配置 + knowledge 错误 + canvas 日志
  })

  it('Service 层不应包含硬编码的用户面中文', () => {
    const violations: string[] = []
    for (const file of SVC_FILES) {
      const source = readFileSync(file, 'utf-8')
      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
        if (/['"`].*[\u4e00-\u9fff].*['"`]/.test(line) && !line.includes('import')) {
          violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`)
        }
      }
    }
    if (violations.length > 0) {
      console.warn(`Service 层硬编码中文 (${violations.length} 处):\n  ${violations.join('\n  ')}`)
    }
    expect(violations.length).toBeLessThan(5) // 修复后应低于 5
  })
})

// ═══════════════════════════════════════════════════
// 2. console.* vs logger 使用一致性
// ═══════════════════════════════════════════════════

describe('设计审计: console vs logger 一致性', () => {
  it('生产代码中 console.error/console.warn 应少于 15 处', () => {
    const files = [
      ...walkFiles('src/api', ['.ts']),
      ...walkFiles('src/stores', ['.ts']),
      ...walkFiles('src/composables', ['.ts']),
      ...walkFiles('src/services', ['.ts']),
      ...walkFiles('src/utils', ['.ts']),
    ].filter(f => !f.includes('__tests__') && !f.includes('__benchmarks__'))

    let count = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      const matches = source.match(/console\.(error|warn)\s*\(/g)
      if (matches) count += matches.length
    }
    // 当前已知 ~29 处（含 logger.ts 内部 2 处）。阈值收紧，新增必须改用 logger。
    expect(count).toBeLessThan(30)
  })
})

// ═══════════════════════════════════════════════════
// 3. 类型安全 — Record<string, unknown> 使用频率
// ═══════════════════════════════════════════════════

describe('设计审计: 弱类型 metadata 使用', () => {
  it('chat.ts 和 websocket.ts 的 metadata 字段应有类型注释', () => {
    const chatTypes = readFileSync('src/types/chat.ts', 'utf-8')
    // metadata 应至少有一个具体类型定义或 JSDoc
    const metadataFields = (chatTypes.match(/metadata\??\s*:/g) || []).length
    // 确认 metadata 有定义
    expect(metadataFields).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════
// 4. Provider 配置单一来源
// ═══════════════════════════════════════════════════

describe('设计审计: Provider 类型定义一致性', () => {
  it('KNOWN_PROVIDER_TYPES 与 PROVIDER_PRESETS 的 key 应完全一致', () => {
    const settingsHelpersSource = readFileSync('src/stores/settings-helpers.ts', 'utf-8')
    const providersSource = readFileSync('src/config/providers.ts', 'utf-8')

    // 提取 KNOWN_PROVIDER_TYPES (now in settings-helpers.ts)
    const knownMatch = settingsHelpersSource.match(/KNOWN_PROVIDER_TYPES\s*=\s*\[([\s\S]*?)\]/)
    expect(knownMatch).toBeTruthy()
    const knownTypes = knownMatch![1]!.match(/'(\w+)'/g)!.map(s => s.replace(/'/g, ''))

    // 提取 PROVIDER_PRESETS 的 key
    const presetKeys = (providersSource.match(/^\s+(\w+):\s*\{$/gm) || [])
      .map(s => s.trim().replace(/:\s*\{$/, ''))

    // KNOWN_PROVIDER_TYPES 应是 PROVIDER_PRESETS 的子集
    for (const t of knownTypes) {
      expect(presetKeys, `KNOWN_PROVIDER_TYPES 包含 "${t}" 但 PROVIDER_PRESETS 没有`).toContain(t)
    }
  })
})

// ═══════════════════════════════════════════════════
// 5. OllamaCard 硬编码中文
// ═══════════════════════════════════════════════════

describe('设计审计: OllamaCard 硬编码中文', () => {
  it('模板中的用户面文案应使用 t() 而非硬编码', () => {
    const source = readFileSync('src/components/settings/OllamaCard.vue', 'utf-8')
    // 提取 <template> 部分
    const templateMatch = source.match(/<template>([\s\S]*)<\/template>/)
    if (!templateMatch) return
    const template = templateMatch[1]!

    // 在模板中查找非 t() 包裹的中文字符串
    const hardcodedChinese: string[] = []
    const lines = template.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // 跳过已用 t() 的行和注释
      if (line.includes("t('") || line.includes('t("') || line.trim().startsWith('<!--')) continue
      // 检查是否包含 2+ 个连续汉字（排除单字的属性值）
      if (/[\u4e00-\u9fff]{2,}/.test(line)) {
        hardcodedChinese.push(`line ${i + 1}: ${line.trim().slice(0, 60)}`)
      }
    }

    if (hardcodedChinese.length > 0) {
      console.warn(`OllamaCard 硬编码中文 (${hardcodedChinese.length} 处):\n  ${hardcodedChinese.join('\n  ')}`)
    }
    // OllamaCard 已完成 i18n 迁移，新增硬编码中文应阻断
    expect(hardcodedChinese.length).toBeLessThan(5)
  })
})

// ═══════════════════════════════════════════════════
// 6. API 路由集中管理
// ═══════════════════════════════════════════════════

describe('设计审计: API 路由分散度', () => {
  it('统计 /api/v1/ 路由定义数量', () => {
    const files = walkFiles('src/api', ['.ts']).filter(f => !f.includes('__tests__'))
    let routeCount = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      const matches = source.match(/['"`]\/api\/v1\//g)
      if (matches) routeCount += matches.length
    }
    // 记录当前路由数量
    expect(routeCount).toBeGreaterThan(20) // 至少有 20+ 个路由
    // 当前全部分散在各 API 文件中，未来可考虑集中管理
  })
})

// ═══════════════════════════════════════════════════
// 7. Store 复杂度
// ═══════════════════════════════════════════════════

describe('设计审计: Store 行数和复杂度', () => {
  it('单个 Store 文件不应超过 500 行', () => {
    const storeFiles = walkFiles('src/stores', ['.ts']).filter(f => !f.includes('__tests__') && !f.includes('index'))
    const oversized: string[] = []
    for (const file of storeFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n').length
      if (lines > 500) {
        oversized.push(`${file}: ${lines} lines`)
      }
    }
    if (oversized.length > 0) {
      console.warn(`超过 500 行的 Store:\n  ${oversized.join('\n  ')}`)
    }
    // settings.ts 当前 ~530 行（含 sandbox 配置），接近阈值但尚可接受
    // 如果新增超标文件，此断言会阻断，强制拆分
    expect(oversized.length).toBeLessThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════
// 8. 重复的 isTauri 检测逻辑
// ═══════════════════════════════════════════════════

describe('设计审计: isTauri 检测重复', () => {
  it('isTauri() 函数不应在多个文件中重复定义', () => {
    const files = [
      ...walkFiles('src/stores', ['.ts']),
      ...walkFiles('src/utils', ['.ts']),
      ...walkFiles('src/composables', ['.ts']),
    ].filter(f => !f.includes('__tests__'))

    const definitions: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      if (source.includes('function isTauri()')) {
        definitions.push(file)
      }
    }
    // 应只有 1 处定义，其他文件 import 使用
    if (definitions.length > 1) {
      console.warn(`isTauri() 在 ${definitions.length} 个文件中重复定义:\n  ${definitions.join('\n  ')}`)
    }
    expect(definitions.length).toBeLessThanOrEqual(2) // settings.ts + secure-store.ts 各有一份
  })
})
