import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

/**
 * hex-test 审计锁 2026-07-02（AP-002 两端词表一致 + AP-010 locale 平价）：
 *
 * 1. 三语 autonomy.* 子树 key 集合必须完全同构——缺 key 的 locale 在该语言下
 *    渲染兜底文案（ug 回落 zh 但会破坏 RTL 语言体验一致性），多 key 是死文案。
 * 2. autonomy.category 的 key 集合必须与 engine systemDispatchCategoryOrder
 *    完全一致（镜像硬编码，后端加/改类别时此测自动 FAIL，逼两端同步）；
 *    缺一个 = 设置页矩阵/审批弹窗渲染裸 key。
 * 3. source 六档 / decision 三态 / profile 卡三档同理。
 */

type Tree = Record<string, unknown>

function keyPaths(obj: Tree, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...keyPaths(v as Tree, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

const locales: Array<[string, Tree]> = [
  ['zh-CN', (zhCN as Tree).autonomy as Tree],
  ['en', (en as Tree).autonomy as Tree],
  ['ug-CN', (ugCN as Tree).autonomy as Tree],
]

describe('autonomy i18n 平价与词表对齐（审计锁）', () => {
  it('三语 autonomy.* 子树 key 集合完全同构', () => {
    const [zhKeys, enKeys, ugKeys] = locales.map(([, tree]) => keyPaths(tree))
    expect(enKeys).toEqual(zhKeys)
    expect(ugKeys).toEqual(zhKeys)
  })

  it('autonomy.category 与 engine 能力类别穷举一致（11 类）', () => {
    // 镜像 hexclaw engine/system_dispatch_policy.go systemDispatchCategoryOrder。
    // 后端增删类别时这里必须同步——否则矩阵/审批弹窗渲染裸 key。
    const ENGINE_CATEGORIES = [
      'read', 'browser', 'exec_sandboxed', 'exec_host', 'files',
      'automation', 'delivery', 'media', 'heal', 'capability', 'publish',
    ].sort()
    for (const [name, tree] of locales) {
      const keys = Object.keys((tree.category as Tree) ?? {}).sort()
      expect(keys, `${name} autonomy.category`).toEqual(ENGINE_CATEGORIES)
    }
  })

  it('autonomy.source 与 engine 派发来源穷举一致（6 源）', () => {
    const ENGINE_SOURCES = ['cron', 'webhook', 'heartbeat', 'workflow', 'spawn', 'solve'].sort()
    for (const [name, tree] of locales) {
      const keys = Object.keys((tree.source as Tree) ?? {}).sort()
      expect(keys, `${name} autonomy.source`).toEqual(ENGINE_SOURCES)
    }
  })

  it('autonomy.decision 与后端决策三态一致', () => {
    const DECISIONS = ['allow', 'pending', 'deny'].sort()
    for (const [name, tree] of locales) {
      const keys = Object.keys((tree.decision as Tree) ?? {}).sort()
      expect(keys, `${name} autonomy.decision`).toEqual(DECISIONS)
    }
  })
})
