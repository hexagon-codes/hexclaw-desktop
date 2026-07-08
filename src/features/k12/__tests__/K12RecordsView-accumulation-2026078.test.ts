import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import HcSelect from '@/components/common/HcSelect.vue'

// #4/#5（hex-test 闭环）：积累本手动记录入口 + 语/英分科过滤。
// 后端 POST /accumulation（k12AddAccumulation）真 + GET /accumulation?subject=（store BUG-3 已通），
// 但原 UI 无「记到积累本」入口、loadAccumulation 不传 subject、无学科筛选切换器。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  addSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: (agent: string, subject?: string) => h.listSpy(agent, subject),
  k12AddAccumulation: (req: unknown) => h.addSpy(req),
  k12ReviewRetry: vi.fn(),
  k12ExportMd: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

async function gotoAccum(w: ReturnType<typeof render>) {
  await w.findAll('.seg button').find((b) => b.text() === k12Zh.subTabs.accumulation)!.trigger('click')
  await flushPromises()
}

describe('K12RecordsView 积累本（#4 手动记录 + #5 分科过滤）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.listSpy.mockReset().mockResolvedValue({ items: [] })
    h.addSpy.mockReset().mockResolvedValue({ record_id: 'x', created: true })
  })

  it('#5 分科过滤：点「语文」chip → 以 subject=语文 重新拉取积累本', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    h.listSpy.mockClear()

    const chip = w.find('[data-testid="accum-filter-chinese"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    await flushPromises()

    expect(h.listSpy).toHaveBeenCalled()
    const lastCall = h.listSpy.mock.calls[h.listSpy.mock.calls.length - 1]!
    expect(lastCall[1]).toBe('语文')
  })

  it('#5 分科过滤：点「全部」→ 不带 subject 拉全量', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    // 先切语文再切全部
    await w.find('[data-testid="accum-filter-chinese"]').trigger('click')
    await flushPromises()
    h.listSpy.mockClear()
    await w.find('[data-testid="accum-filter-all"]').trigger('click')
    await flushPromises()

    const lastCall = h.listSpy.mock.calls[h.listSpy.mock.calls.length - 1]!
    expect(lastCall[1]).toBeUndefined()
  })

  it('#4 手动记录：填表提交 → 调 k12AddAccumulation 并刷新', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()

    // 选学科英语、类型好词好句（学科/类型下拉走 HcSelect，D5：不再用原生 select）、填内容
    w.findAllComponents(HcSelect)[0]!.vm.$emit('update:modelValue', '英语')
    w.findAllComponents(HcSelect)[1]!.vm.$emit('update:modelValue', '好词好句')
    await flushPromises()
    await w.find('[data-testid="accum-add-content"]').setValue('a piece of cake')
    h.listSpy.mockClear()
    await w.find('[data-testid="accum-add-submit"]').trigger('click')
    await flushPromises()

    expect(h.addSpy).toHaveBeenCalledTimes(1)
    const req = h.addSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    expect(req.subject).toBe('英语')
    expect(req.entry_type).toBe('好词好句')
    expect(req.content).toBe('a piece of cake')
    // 提交后重新拉取积累本
    expect(h.listSpy).toHaveBeenCalled()
  })

  it('#4 手动记录：内容为空时提交按钮禁用', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()
    const submit = w.find('[data-testid="accum-add-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
  })
})
