/**
 * BUG-20260712（真机）· 积累 tab 行「再练/详情」死按钮。
 * 根因：shell RecordList 无条件给每行渲染「再练」+「详情」，而积累 tab 的 <RecordList> 没挂 @action
 *       → 两按钮 no-op。积累行只应有「详情」（积累不复习/不再练）。
 * 治本：① RecordList 按 schema.reviewable 门控练习动作——不可复习集合不渲染；
 *       ② K12RecordsView 给积累 RecordList 接线 @action（详情走真 handler）。
 *
 * RED（修前）：积累行渲染「再练」按钮；@action 未接线 → 详情点了无反应。
 * GREEN（修后）：积累行无练习动作、详情按钮点击打开真详情弹层；错题行仍有
 * 当前「加入练习集」动作+详情（不回归）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA } from '../schemas'
import type { RecordCollectionView } from '@/contracts'

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

const accumView: RecordCollectionView = {
  collection: '积累本', schemaVersion: '1',
  items: [
    { recordId: 'x1', agentId: 'a', collection: '积累本', schemaVersion: '1', status: 'new',
      fields: { content: 'a piece of cake', subject: '英语', entry_type: '好词好句' }, version: 0 },
  ],
}
const mistakeView: RecordCollectionView = {
  collection: '错题本', schemaVersion: '1', reviewQueue: [],
  items: [
    { recordId: 'm1', agentId: 'a', collection: '错题本', schemaVersion: '1', status: 'new',
      fields: { question: '3.8×3', knowledge_point: '小数乘法', error_cause: '进位错' }, version: 0 },
  ],
}

describe('BUG-20260712 #2 记录行内动作按 schema.reviewable 门控', () => {
  beforeEach(() => {})

  it('积累行（reviewable=false）不渲染「再练」，只渲染「详情」', () => {
    const w = mount(RecordList, { props: { schema: ACCUMULATION_SCHEMA, view: accumView }, global: { plugins: [i18n()] } })
    const btns = w.findAll('.rl-row .rl-btn').map((b) => b.text())
    expect(btns, '积累不复习，不应有「再练」死按钮').not.toContain('再练')
    expect(btns).toContain('详情')
  })

  it('积累行「详情」点击外派 detail action（@action 接线不空）', async () => {
    const w = mount(RecordList, { props: { schema: ACCUMULATION_SCHEMA, view: accumView }, global: { plugins: [i18n()] } })
    await w.findAll('.rl-row .rl-btn').find((b) => b.text() === '详情')!.trigger('click')
    const ev = w.emitted('action')
    const firstEvent = ev?.[0]?.[0] as { id: string } | undefined
    if (!firstEvent) throw new Error('前置：详情操作事件缺失')
    expect(firstEvent.id).toBe('detail')
  })

  it('错题行（reviewable=true）仍承载当前「加入练习集」+「详情」（不回归）', () => {
    const w = mount(RecordList, {
      props: { schema: MISTAKE_SCHEMA, view: mistakeView },
      slots: {
        'list-practice-action': '<button class="rl-btn">加入练习集</button>',
      },
      global: { plugins: [i18n()] },
    })
    const btns = w.findAll('.rl-row .rl-btn').map((b) => b.text())
    expect(btns).toContain('加入练习集')
    expect(btns).toContain('详情')
  })
})
