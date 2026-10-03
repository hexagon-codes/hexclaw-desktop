import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * AP-1 前端回归锁：通用 chat shell / 通用组件不 import K12 场景包。
 * 场景依赖只属于 features/k12 皮肤层与后端 schema 声明。
 *
 * 通用组件通过中性 schema 和 registry 消费场景能力，不能直接依赖单一领域。
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

describe('AP-1 前端守门：通用组件无 K12 场景依赖', () => {
  const files = GENERIC_DIRS.flatMap((d) => walk(join(srcRoot, d)))

  it('扫描到通用组件文件（守门本身有效）', () => {
    expect(files.length).toBeGreaterThan(5)
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
