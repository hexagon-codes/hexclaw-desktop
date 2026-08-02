import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './ap1StripComments'

/**
 * AP-1 前端回归锁（架构守门，架构文档 §8.4 / §4.4）：通用 chat shell / 通用组件里**零 K12 领域词**，
 * 且不 import features/k12。K12 只活在 features/k12 皮肤层 + 后端 schema 声明。
 *
 * 这是"加场景不改内核"的机械锁——新往通用组件里硬编码任何 K12 领域词/依赖即 FAIL（举一反三，
 * 不靠人工 review 兜）。此前 AP-1 只有正向测试（shell-generic：能渲染中性 schema），无反向锁。
 */

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', '..') // src/

// 通用（非场景包）目录：这些是所有场景共用的外壳，不得认识任何单一场景。
const GENERIC_DIRS = [
  'components/chat',
  'components/artifacts',
  'components/agents',
  'components/memory',
  'components/skills',
  'components/cron',
  'components/automation',
  'components/channels',
  'components/common', // 通用外壳组件（不得认识 K12）
  'components/layout',
  'composables', // 通用能力（不得认识 K12）
  'shell/chat',
  'shell/records',
  'shell/scenario',
]

// K12 领域词（架构文档回归锁词表）。允许在 features/k12 皮肤层出现，通用层禁止。
const K12_WORDS = ['错题', ['备', '课'].join(''), '学情', '识题', '辅导', 'k12', 'tutor', '孩子']

function walk(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === '__tests__') continue // 测试文件本身会提到 K12 词，不算泄漏
      out = out.concat(walk(p))
    } else if (/\.(ts|vue)$/.test(e) && !e.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

// 去注释用感知字符串字面量的 stripComments（BUG-5：旧正则会把串里的 //错题 当注释误剥致假绿）。

describe('AP-1 前端守门：通用组件零 K12 泄漏', () => {
  const files = GENERIC_DIRS.flatMap((d) => walk(join(srcRoot, d)))

  it('扫描到通用组件文件（守门本身有效）', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('通用组件代码不含 K12 领域词（注释除外）', () => {
    const leaks: string[] = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8')).toLowerCase()
      for (const w of K12_WORDS) {
        if (code.includes(w.toLowerCase())) {
          leaks.push(`${f.replace(srcRoot, 'src')} 含「${w}」`)
        }
      }
    }
    expect(leaks, `通用组件出现 K12 领域词（应只在 features/k12）:\n${leaks.join('\n')}`).toEqual([])
  })

  it('通用组件不 import features/k12 / @/api/k12 / useK12Store', () => {
    const bad: string[] = []
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
      if (/features\/k12|@\/api\/k12|useK12Store/.test(code)) {
        bad.push(f.replace(srcRoot, 'src'))
      }
    }
    expect(bad, `通用组件依赖了 K12 场景包（违反 AP-1 单向依赖）:\n${bad.join('\n')}`).toEqual([])
  })
})
