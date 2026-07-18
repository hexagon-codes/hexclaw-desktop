import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import VerifyBadge from '../chat/VerifyBadge.vue'
import RecordChip from '../chat/RecordChip.vue'
import RecordList from '../records/RecordList.vue'
import { scenarioRegistry } from '../scenario/registry'
import type { RecordSchema, RecordCollectionView, InstanceViewDescriptor, VerifyResult } from '@/contracts'

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    // 注入中性 demo 文案，模拟场景包 merge（shell 不认识这些 key 的语义）
    messages: {
      'zh-CN': { ...zhCN, demo: { notes: '便签', s: { todo: '待办', got: '完成' } } },
      zh: zhCN,
    },
  })
}

// 中性 demo schema（零 K12 词）——若 shell 是领域无关的，它就能渲染任意 schema
const DEMO_SCHEMA: RecordSchema = {
  collection: 'demo-notes',
  schemaVersion: '1',
  labelKey: 'demo.notes',
  reviewable: true,
  fields: [
    { key: 'title', labelKey: 'demo.notes', type: 'string', role: 'title' },
    { key: 'tag', labelKey: 'demo.notes', type: 'string', role: 'chip' },
    { key: 'note', labelKey: 'demo.notes', type: 'string', role: 'meta' },
    { key: 'at', labelKey: 'demo.notes', type: 'date', role: 'date' },
  ],
  states: [
    { id: 'todo', labelKey: 'demo.s.todo', tone: 'todo' },
    { id: 'got', labelKey: 'demo.s.got', tone: 'got' },
  ],
}

const DEMO_VIEW: RecordCollectionView = {
  collection: 'demo-notes',
  schemaVersion: '1',
  reviewQueue: ['r1'],
  items: [
    { recordId: 'r1', agentId: 'a1', collection: 'demo-notes', schemaVersion: '1', status: 'todo',
      fields: { title: '第一条', tag: '标签A', note: '备注一', at: '07-03' }, version: 1 },
    { recordId: 'r2', agentId: 'a1', collection: 'demo-notes', schemaVersion: '1', status: 'got',
      fields: { title: '第二条', tag: '标签B', note: '备注二', at: '07-01' }, version: 1 },
  ],
}

describe('VerifyBadge（通用验算徽章）', () => {
  const render = (result: VerifyResult) =>
    mount(VerifyBadge, { props: { result }, global: { plugins: [i18n()] } })

  it('agree + 强证据 → 显"已程序验算" + scopeNote', () => {
    const w = render({ verdict: 'agree', evidence: 'program_verified', scopeNote: '五年级上范围内' })
    expect(w.text()).toContain('已程序验算')
    expect(w.text()).toContain('五年级上范围内')
    expect(w.find('.verify-badge--ok').exists()).toBe(true)
  })

  it('agree + 弱证据（同源模型复核）→ 不显"已程序验算"强徽章', () => {
    const w = render({ verdict: 'agree', evidence: 'model_review' })
    expect(w.text()).not.toContain('已程序验算')
    expect(w.text()).toContain('已核对')
  })

  it('disagree → 并列双答 + 不装懂提示', () => {
    const w = render({ verdict: 'disagree', evidence: 'program_verified', answers: ['x=3', 'x=2'] })
    expect(w.find('.verify-badge--warn').exists()).toBe(true)
    expect(w.text()).toContain('x=3')
    expect(w.text()).toContain('x=2')
    expect(w.findAll('.verify-badge__answers li')).toHaveLength(2)
  })

  it('out_of_scope → 超纲态 + 已重解', () => {
    const w = render({ verdict: 'out_of_scope', evidence: 'program_verified', outOfScope: { detected: '二元一次方程组' } })
    expect(w.text()).toContain('超出当前范围')
    expect(w.text()).toContain('二元一次方程组')
  })
})

describe('RecordChip（入库徽章 · schema 驱动数据）', () => {
  it('渲染 已记入{集合} + 字段 chip + 状态', () => {
    const w = mount(RecordChip, {
      props: { collectionLabel: '错题本', chips: ['知识点【小数乘法】', '错因【进位】'], statusLabel: '待复习' },
      global: { plugins: [i18n()] },
    })
    expect(w.text()).toContain('已记入错题本')
    expect(w.text()).toContain('知识点【小数乘法】')
    expect(w.text()).toContain('状态：待复习')
  })
  it('无状态 → 不显状态段', () => {
    const w = mount(RecordChip, {
      props: { collectionLabel: '积累本', chips: [] },
      global: { plugins: [i18n()] },
    })
    expect(w.text()).not.toContain('状态：')
  })
})

describe('RecordList（schema 驱动通用记录视图）', () => {
  const render = () =>
    mount(RecordList, { props: { schema: DEMO_SCHEMA, view: DEMO_VIEW }, global: { plugins: [i18n()] } })

  it('按 schema 渲染标题/标签/状态/日期，无需硬编码字段名', () => {
    const w = render()
    expect(w.text()).toContain('第一条')
    expect(w.text()).toContain('标签A')
    expect(w.text()).toContain('07-03')
    expect(w.find('.rl-status--todo').exists()).toBe(true)
    expect(w.find('.rl-status--got').exists()).toBe(true)
  })

  it('reviewable + reviewQueue → 渲染复习队列区', () => {
    const w = render()
    expect(w.find('.rl-review').exists()).toBe(true)
    // 20260718 §4.11 术语统一：records.reviewQueueTitle「本周该练」→「本周复习」
    expect(w.text()).toContain('本周复习')
  })

  it('状态筛选：点"完成"只显 got 记录（作用于全部列表，不影响复习队列）', async () => {
    const w = render()
    // 全部列表行带状态 pill；复习队列行不带 → 用 .rl-status 精确定位全部列表
    expect(w.findAll('.rl-status')).toHaveLength(2)
    const gotTag = w.findAll('.rl-tag').find((t) => t.text() === '完成')!
    await gotTag.trigger('click')
    const pills = w.findAll('.rl-status')
    expect(pills).toHaveLength(1)
    expect(pills[0]!.text()).toBe('完成')
  })

  it('每行复习动作外派 action 事件', async () => {
    const w = render()
    await w.findAll('.rl-btn').find((b) => b.text() === '再练一道')!.trigger('click')
    const ev = w.emitted('action')
    expect(ev).toBeTruthy()
    const payload = ev?.[0]?.[0] as { id: string } | undefined
    expect(payload?.id).toBe('practiceAgain')
  })
})

describe('scenarioRegistry（ViewExtensionRegistry 注入缝 · §6.4）', () => {
  beforeEach(() => scenarioRegistry.reset())

  it('加 mock 场景包：注册描述符 + schema + 动作，shell 零改即能解析', () => {
    const descriptor: InstanceViewDescriptor = {
      schemaVersion: '1',
      headerTabs: [{ id: 'notes', labelKey: 'demo.notes', kind: 'records', collection: 'demo-notes' }],
      messageBadges: ['verify'],
      recordCollections: [{ collection: 'demo-notes', labelKey: 'demo.notes', schemaVersion: '1' }],
      sidePanels: [{ id: 'demo-panel', titleKey: 'demo.notes' }],
      actions: [{ id: 'demo-action', labelKey: 'demo.notes' }],
    }
    scenarioRegistry.registerDescriptor('demo', descriptor)
    scenarioRegistry.registerSchema(DEMO_SCHEMA)
    scenarioRegistry.registerResolver((ctx) => (ctx.metadata?.scenario === 'demo' ? descriptor : null))

    let ran = ''
    scenarioRegistry.registerActionHandler('demo-action', (ctx) => { ran = ctx.agentId })

    // 命中场景 → 返回其描述符（四缝：tab/badge/记录集/侧栏/动作都在）
    const resolved = scenarioRegistry.resolveDescriptor({ agentId: 'a1', metadata: { scenario: 'demo' } })
    expect(resolved.headerTabs[0]!.collection).toBe('demo-notes')
    expect(resolved.sidePanels[0]!.id).toBe('demo-panel')
    expect(scenarioRegistry.getSchema('demo-notes')?.reviewable).toBe(true)

    scenarioRegistry.runAction('demo-action', { agentId: 'a1' })
    expect(ran).toBe('a1')
  })

  it('未命中场景 → 返回空描述符（普通会话零增强）', () => {
    const resolved = scenarioRegistry.resolveDescriptor({ agentId: 'x' })
    expect(resolved.headerTabs).toHaveLength(0)
    expect(resolved.recordCollections).toHaveLength(0)
  })
})
