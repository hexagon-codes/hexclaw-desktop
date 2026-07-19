import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecordList from '@/shell/records/RecordList.vue'
import K12RecordsView from '../views/K12RecordsView.vue'

// BUG-20260712-#4 再练取消：出题是 60-120s 的 solve 验算链。此前关弹窗既不中止后台（空烧算力），
// 请求跑完还 open:true 把弹窗幽灵重开。修：closeRetry abort 中止 + generation 守卫丢弃过期结果。

const h = vi.hoisted(() => ({ deferred: null as ((v: unknown) => void) | null, signal: undefined as AbortSignal | undefined }))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [{ record_id: 'a', question: 'Q', knowledge_point: 'kp', error_cause: 'ec', status: 'new', version: 0, due_at: 1710000000 }] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: (_req: unknown, signal?: AbortSignal) => { h.signal = signal; return new Promise((r) => { h.deferred = r }) },
  k12PrepCard: vi.fn(), k12Grade: vi.fn(),
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

describe('BUG-20260712-#4 再练取消：关弹窗中止后台 + 不幽灵重开', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.deferred = null; h.signal = undefined })

  it('出题中关弹窗 → signal.aborted 且过期结果不重开弹窗', async () => {
    const w = render()
    await flushPromises()
    // 触发「再练一道」（RecordList 上抛 action）
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    expect(w.find('.k12retry').exists()).toBe(true) // 弹窗开·出题中

    // 关弹窗（点 ✕，.k12retry 内首个 button）
    await w.find('.k12retry button').trigger('click')
    expect(w.find('.k12retry').exists()).toBe(false) // 已关闭
    expect(h.signal?.aborted).toBe(true) // 后台出题被中止（RED：修前无 abort → false/undefined）

    // 过期请求现在才返回 → 不得幽灵重开弹窗
    h.deferred?.({ solution: 'x', badge: 'y', verdict: 'agree' })
    await flushPromises()
    expect(w.find('.k12retry').exists()).toBe(false) // 不幽灵重开（RED：修前 open:true → true）
  })

  it('出题中切换孩子 → 中止旧孩子请求并关闭旧弹层', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    const oldSignal = h.signal

    await w.setProps({ agentId: 'xiaohong' })
    await flushPromises()
    expect(oldSignal?.aborted).toBe(true)
    expect(w.find('.k12retry').exists()).toBe(false)
  })

  it('组件卸载时中止仍在运行的再练请求', async () => {
    const w = render()
    await flushPromises()
    w.findComponent(RecordList).vm.$emit('action', { id: 'practiceAgain', record: { recordId: 'a', version: 0 } })
    await flushPromises()
    const signal = h.signal

    w.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
