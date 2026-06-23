/**
 * ConnectionsView prototype alignment — verifies the refined connections view:
 *   - real ConnectionChannelCards flow on the channels tab
 *   - data connectors are now an INSTANCE LIST + two-step add modal (mirrors the
 *     channels instance+modal model); the static catalog moved into the modal's
 *     first step (type picker), fed by the flat CONNECTOR_TYPES constant
 *     (10 types, no grouping / no category labels).
 *   - design-token-only styling (no hardcoded hex)
 *
 * The explanatory chrome (local-first badge, model→settings jump card, callout,
 * status-pill legend, dashed "add connector" card) has been removed; the top-bar
 * "add" button is the only entry point.
 *
 * Static source + i18n coverage (matches the repo's existing view-test style).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

const SRC = resolve(__dirname, '..')
const view = readFileSync(resolve(SRC, 'views/ConnectionsView.vue'), 'utf-8')
// 数据目录从 tab 移进了弹窗第一步（类型选择器）——校验它在弹窗里渲染。
const modal = readFileSync(
  resolve(SRC, 'components/channels/ConnectorConfigModal.vue'),
  'utf-8',
)
// 实例 store（模块级 + localStorage 持久化）。
const store = readFileSync(resolve(SRC, 'composables/useConnectorInstances.ts'), 'utf-8')

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

describe('ConnectionsView — channels tab renders the real connection cards', () => {
  it('renders the ConnectionChannelCards flow, not the removed chrome', () => {
    expect(view).toContain('ConnectionChannelCards')
    // The explanatory chrome must be gone.
    expect(view).not.toContain('hc-conn-badge')
    expect(view).not.toContain('hc-conn-jump')
    expect(view).not.toContain('hc-conn-callout')
    expect(view).not.toContain('hc-conn-legend')
    expect(view).not.toContain('hc-conn-card--dashed')
  })
})

describe('ConnectionsView — design tokens only (no hardcoded colors)', () => {
  it('new connection styles use var(--hc-*) / color-mix, not raw hex', () => {
    // Extract the <style scoped> block and assert no raw 6-digit hex colors.
    const styleMatch = view.match(/<style scoped>([\s\S]*)<\/style>/)
    expect(styleMatch).not.toBeNull()
    const styles = styleMatch![1]
    expect(styles).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    expect(styles).toContain('var(--hc-')
  })
})

// ─── 数据连接器：实例列表 + 两步弹窗（对齐通道的实例+弹窗模式）────────────
describe('ConnectionsView — connectors are an instance list + add modal', () => {
  it('the connectors tab renders the instance store list, not the static catalog', () => {
    // 实例 store 接入 + 实例卡列表渲染。
    expect(view).toContain('useConnectorInstances')
    expect(view).toMatch(/v-for="inst in filteredConnectorInstances"/)
    // 顶栏「添加」开两步弹窗，编辑实例也走同一弹窗。
    expect(view).toContain('ConnectorConfigModal')
    expect(view).toContain('openConnectorEdit')
    // 静态分组目录不再在 tab 里直接渲染。
    expect(view).not.toMatch(/v-for="g in filteredConnectorGroups"/)
  })

  it('empty list shows an empty state (prompting to add)', () => {
    expect(view).toContain('EmptyState')
    expect(view).toMatch(/filteredConnectorInstances\.length === 0/)
  })

  it('feeds the flat catalog into the modal as the type picker (CONNECTOR_TYPES retained)', () => {
    // 扁平数据常量保留，投影成弹窗第一步的类型选择器数据源。
    expect(view).toContain('const CONNECTOR_TYPES')
    expect(view).toContain('connectorTypes')
    expect(view).toMatch(/:types="connectorTypes"/)
  })
})

describe('ConnectorConfigModal — two-step wizard mirrors ChannelConfigModal', () => {
  it('renders the flat type picker (v-for over types, no group titles) in step 1', () => {
    // 第一步：把 types 平铺成扁平网格（每项 logo/monogram + 名称，无分组标题）。
    expect(modal).toMatch(/v-for="it in types"/)
    // 不再有分组渲染 / 组名标题。
    expect(modal).not.toMatch(/v-for="g in groups"/)
    expect(modal).not.toContain('g.title')
    expect(modal).not.toContain('hc-ck-group')
    // logo + monogram fallback（缺图不阻塞）。
    expect(modal).toMatch(/it\.monogram/)
    expect(modal).toContain('selectType')
  })

  it('mirrors the channel modal geometry (.hc-im-modal 520px shell + step1/step2)', () => {
    expect(modal).toContain('Teleport')
    expect(modal).toContain('hc-im-overlay')
    expect(modal).toContain('hc-im-modal')
    expect(modal).toContain('width: 520px')
    expect(modal).toContain('max-width: calc(100vw - 48px)')
    expect(modal).toContain('max-height: 86vh')
    // 两步：step===1 类型选择 / step===2 配置表单。
    expect(modal).toMatch(/step === 1/)
    expect(modal).toMatch(/step === 2/)
  })

  it('saves through the instance store (add on create / update on edit)', () => {
    expect(modal).toContain('useConnectorInstances')
    expect(modal).toContain('addInstance')
    expect(modal).toContain('updateInstance')
    expect(modal).toContain("emit('saved')")
  })
})

describe('useConnectorInstances — module store persisted to localStorage', () => {
  it('exports the CRUD surface + persists under the agreed key', () => {
    expect(store).toContain('hexclaw:connectorInstances')
    expect(store).toContain('addInstance')
    expect(store).toContain('updateInstance')
    expect(store).toContain('removeInstance')
    expect(store).toContain('localStorage')
    expect(store).toContain('crypto.randomUUID')
  })
})

// ─── 数据连接器：扁平 featured 目录（10 源，不分类）────────────────────
// 期望的扁平类型集合（id / method）；与 CONNECTOR_TYPES 数据结构一一对应。
// 顺序对齐已批准的最终目录；数据常量仍在 ConnectionsView 里（无分组）。
const EXPECTED_TYPES: Array<{ id: string; method: string }> = [
  // §15.1 真实只读接入(token 加密存后端)——置顶。
  { id: 'github', method: 'token' },
  { id: 'notion', method: 'token' },
  // 语雀/飞书：从 OAuth 占位改走 MCP（yuque-mcp-server / @larksuiteoapi/lark-mcp）真闭环
  { id: 'yuque', method: 'mcp' },
  { id: 'feishuDoc', method: 'mcp' },
  { id: 'postgres', method: 'mcp' },
  { id: 'mysql', method: 'mcp' },
  { id: 'sqlite', method: 'mcp' },
  { id: 'mongodb', method: 'mcp' },
  { id: 'redis', method: 'mcp' },
  { id: 'localFolder', method: 'native' },
]
const EXPECTED_TOTAL = EXPECTED_TYPES.length // 10

// 从源码里抽出 CONNECTOR_TYPES 字面量，按出现顺序解析 id + method。
function parseConnectorTypes(): Array<{ id: string; method: string }> {
  const start = view.indexOf('const CONNECTOR_TYPES')
  expect(start).toBeGreaterThan(-1)
  const block = view.slice(start, view.indexOf('const connectorTypes'))
  const types: Array<{ id: string; method: string }> = []
  // 每项形如 { id: '<id>', name: '...', method: '<method>' }。
  const itemRe = /id:\s*'([a-zA-Z]+)'[\s\S]*?method:\s*'(native|mcp|oauth|token)'/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(block)) !== null) {
    const id = m[1]
    const method = m[2]
    if (!id || !method) continue
    types.push({ id, method })
  }
  return types
}

describe('ConnectionsView — flat featured connector catalog (no grouping)', () => {
  const types = parseConnectorTypes()

  it('defines exactly the 10 flat types in order (id + method)', () => {
    expect(types).toEqual(EXPECTED_TYPES)
  })

  it('catalogs the flat featured set (10 sources, no group constant)', () => {
    expect(types.length).toBe(EXPECTED_TOTAL)
    // 旧的分组常量 / 分组投影已被扁平结构取代。
    expect(view).not.toContain('CONNECTOR_GROUPS')
    expect(view).not.toContain('connectorTypeGroups')
  })

  it('keeps the logo map with monogram fallback (never blocks on a missing svg)', () => {
    expect(view).toContain('CONNECTOR_LOGOS')
    // monogram fallback lives on both the instance cards and the modal type picker.
    expect(view).toContain('hc-conn-card__mono')
    expect(view).toMatch(/instanceMono/)
    expect(modal).toContain('hc-ck-mono')
  })
})

// 三语对齐：每个连接方式、每个源 meta 都要三语齐全（扁平目录，无分组组名）。
describe('ConnectionsView — connector catalog i18n in all three locales', () => {
  const methodKeys = ['native', 'mcp', 'oauth', 'token']
  const sourceIds = EXPECTED_TYPES.map((t) => t.id)

  const paths = [
    ...methodKeys.map((k) => `connections.connectors.method.${k}`),
    ...methodKeys.map((k) => `connections.connectors.action.${k}`),
    ...sourceIds.map((id) => `connections.connectors.meta.${id}`),
  ]

  for (const locale of [zhCN, en, ugCN] as const) {
    for (const path of paths) {
      it(`${path} is defined`, () => {
        expect(getByPath(locale, path)).toBeTypeOf('string')
      })
    }
  }

  it('meta covers exactly the catalog source ids', () => {
    expect(sourceIds.length).toBe(EXPECTED_TOTAL)
  })
})
