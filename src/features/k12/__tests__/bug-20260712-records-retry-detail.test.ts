import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import K12RecordsView from '../views/K12RecordsView.vue'

// 真机确认 · BUG-20260712：
//  #1 错题「再练」看着像假按钮——retry 端点耗时 ~68s(变式题+solve+code_exec 验算，真实工作量)。
//     前端两个坑：a) k12ReviewRetry 无长 timeout → fetch abort → 弹层被静默关；
//     b) 68s loading 无进度反馈像卡死。治本=api 传 ≥120s timeout + loading 显进度文案 + 失败不静默关。
//  #2 错题「详情」是假按钮——onAction detail 只 toast 占位，无真详情弹层。治本=复用 RecordItem 字段建详情弹层。

const h = vi.hoisted(() => ({ retry: null as unknown as (...a: unknown[]) => Promise<unknown> }))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [{ record_id: 'a', question: '3.8×3 = ?', knowledge_point: '小数乘法', error_cause: '算成了 10.4', status: 'new', version: 0, due_at: 1710000000 }],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: (...args: unknown[]) => h.retry(...args),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 }, weak_top3: [], month_new_mistakes: 1, review_completion_rate: 0, consecutive_fail_kps: [], suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明', grade: '五年级下' },
    global: { plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })] },
  })
}

describe('BUG-20260712 #1 再练：长耗时进度反馈 + 失败不静默关', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.retry = null as unknown as () => Promise<unknown> })

  it('出题中(68s)弹层保持 open 且显明确进度文案（约 1 分钟）', async () => {
    h.retry = () => new Promise(() => {}) // 永不 resolve → 模拟在途长请求
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    expect(w.find('.k12retry').exists()).toBe(true) // 弹层保持打开
    // RED：修前 loading 文案「正在出题并验算…」无时间预期，68s 等待像卡死
    expect(w.find('.k12retry').text()).toContain('约 1 分钟')
  })

  it('失败/超时 → 弹层保持 open 给可重试提示，不静默关', async () => {
    h.retry = () => Promise.reject(new Error('Fetch is aborted'))
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    // RED：修前 catch 里 retry.open=false 静默关弹层 → 用户看着点了没反应
    expect(w.find('.k12retry').exists()).toBe(true)
    expect(w.find('[data-testid="retry-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="retry-again"]').exists()).toBe(true)
  })

  it('api 层 k12ReviewRetry 传 ≥120s timeout（?raw 源码断言）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/api/k12.ts'), 'utf8')
    const at = src.indexOf('export function k12ReviewRetry')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n}', at))
    const m = body.match(/timeout:\s*([\d_]+)/) // RED：修前只有 { signal }，无 timeout
    expect(m).toBeTruthy()
    expect(Number(m?.[1]?.replace(/_/g, ''))).toBeGreaterThanOrEqual(120_000)
  })
})

describe('BUG-20260712 #2 错题详情：真弹层渲染题目/知识点/错因/状态', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.retry = vi.fn() })

  it('点详情 → 弹层打开且渲染完整错题信息', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', {
      id: 'detail',
      record: { recordId: 'a', version: 0, status: 'new', fields: { question: '3.8×3 = ?', knowledge_point: '数学·小数乘法', error_cause: '算成了 10.4' } },
    })
    await flushPromises()
    const modal = w.find('[data-testid="mistake-detail"]')
    // RED：修前 detail 分支只 toast.info，无弹层元素
    expect(modal.exists()).toBe(true)
    expect(modal.text()).toContain('3.8×3') // 题目原文
    expect(modal.text()).toContain('小数乘法') // 知识点
    expect(modal.text()).toContain('算成了 10.4') // 错因
    expect(modal.text()).toContain('待复习') // 复习状态（new → mistakeStatus.new）
  })
})
