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
import recordListSource from '@/shell/records/RecordList.vue?raw'
import { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA } from '../schemas'
import type { RecordCollectionView } from '@/contracts'

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

const accumView: RecordCollectionView = {
  collection: '积累本',
  schemaVersion: '1',
  items: [
    {
      recordId: 'x1',
      agentId: 'a',
      collection: '积累本',
      schemaVersion: '1',
      status: 'new',
      fields: { content: 'a piece of cake', subject: '英语', entry_type: '好词好句' },
      version: 0,
    },
  ],
}
const mistakeView: RecordCollectionView = {
  collection: '错题本',
  schemaVersion: '1',
  reviewQueue: [],
  items: [
    {
      recordId: 'm1',
      agentId: 'a',
      collection: '错题本',
      schemaVersion: '1',
      status: 'new',
      fields: { question: '3.8×3', knowledge_point: '小数乘法', error_cause: '进位错' },
      version: 0,
    },
  ],
}

const NEUTRAL_ROW_GROUPS = [
  'rl-primary',
  'rl-primary__heading',
  'rl-primary__detail',
  'rl-context',
  'rl-actions',
] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssBlock(className: string): string {
  const match = recordListSource.match(
    new RegExp(`\\.${escapeRegExp(className)}\\s*\\{([^}]*)\\}`, 's'),
  )
  return match?.[1] ?? ''
}

describe('BUG-20260712 #2 记录行内动作按 schema.reviewable 门控', () => {
  beforeEach(() => {})

  it('积累行（reviewable=false）不渲染「再练」，只渲染「详情」', () => {
    const w = mount(RecordList, {
      props: { schema: ACCUMULATION_SCHEMA, view: accumView },
      global: { plugins: [i18n()] },
    })
    const btns = w.findAll('.rl-row .rl-btn').map((b) => b.text())
    expect(btns, '积累不复习，动作集合与顺序必须保持为唯一的「详情」').toEqual(['详情'])
    expect(w.findAll('.rl-row .rl-actions .rl-btn').map((b) => b.text())).toEqual(['详情'])
  })

  it('积累行「详情」点击外派 detail action（@action 接线不空）', async () => {
    const w = mount(RecordList, {
      props: { schema: ACCUMULATION_SCHEMA, view: accumView },
      global: { plugins: [i18n()] },
    })
    await w
      .findAll('.rl-row .rl-btn')
      .find((b) => b.text() === '详情')!
      .trigger('click')
    const ev = w.emitted('action')
    const firstEvent = ev?.[0]?.[0] as { id: string } | undefined
    if (!firstEvent) throw new Error('前置：详情操作事件缺失')
    expect(firstEvent.id).toBe('detail')
  })

  it('可复习消费者按 practice → row-actions → mastery → detail 保持动作 exact-set 与顺序', () => {
    const w = mount(RecordList, {
      props: { schema: MISTAKE_SCHEMA, view: mistakeView },
      slots: {
        'list-practice-action': '<button class="rl-btn">加入练习集</button>',
        'list-row-actions': '<button class="rl-btn">不再复习</button>',
      },
      global: { plugins: [i18n()] },
    })
    const btns = w.findAll('.rl-row .rl-btn').map((b) => b.text())
    const expected = ['加入练习集', '不再复习', '家长确认已会', '详情']
    expect(btns).toEqual(expected)
    expect(w.findAll('.rl-row .rl-actions .rl-btn').map((b) => b.text())).toEqual(expected)
  })

  it('RecordList 的结构分组保持领域中性，默认不改变任何消费者的布局语义', () => {
    for (const className of NEUTRAL_ROW_GROUPS) {
      const openingTag = recordListSource.match(
        new RegExp(`<[^>]+class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`),
      )?.[0]

      expect(openingTag, `${className} 必须由通用 RecordList 无条件提供`).toBeTruthy()
      expect(openingTag).not.toMatch(
        /v-if|v-show|status|collection|mistake|accumulation|k12|错题|积累|待复习|已掌握/i,
      )
      expect(cssBlock(className), `${className} 默认只能透明参与既有行布局`).toMatch(
        /display:\s*contents\s*;/,
      )
    }
  })
})
