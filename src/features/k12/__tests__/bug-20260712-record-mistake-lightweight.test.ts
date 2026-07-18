/**
 * BUG-20260712（真机）· 记一条错题「验算 1-2 分钟」过度验算。
 * 根因：手动「记一条错题」走 store.grade → POST /grade 的完整 solve+verify 对抗验算链（真机 1-2 分钟）。
 * 但家长手动记的是**已知错题**，不需要判对错的重验算。
 * 治本：走轻量 POST /record-mistake 端点直录（题目+答案入库 + 单次轻量错因归纳），秒级完成。
 *
 * RED（修前）：submitMistake 调 k12Grade；按钮文案「验算并记入」/「验算中…（约 1-2 分钟）」。
 * GREEN（修后）：submitMistake 调 k12RecordMistake，绝不调 k12Grade；文案改「记入错题本」/「记入中…」，不再「1-2分钟」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({ gradeSpy: vi.fn(), recordMistakeSpy: vi.fn() }))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: (req: unknown) => h.gradeSpy(req),
  k12RecordMistake: (req: unknown) => h.recordMistakeSpy(req),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

describe('BUG-20260712 记一条错题：轻量直录，不跑对抗验算链', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.gradeSpy.mockReset()
    h.recordMistakeSpy.mockReset().mockResolvedValue({ record_created: true, record_id: 'm-1', error_cause: '进位算错' })
  })

  it('提交调轻量 record-mistake 端点，绝不调 grade 验算链', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')
    w.find('[data-testid="mistake-subject"]').findComponent(HcSelect).vm.$emit('update:modelValue', '数学')
    await w.find('[data-testid="mistake-problem"]').setValue('3.8×3')
    await w.find('[data-testid="mistake-submit"]').trigger('click')
    await flushPromises()

    expect(h.recordMistakeSpy).toHaveBeenCalledTimes(1)
    expect(h.gradeSpy, '记一条错题绝不能触发 grade 对抗验算链（1-2 分钟根因）').not.toHaveBeenCalled()
  })

  it('提交按钮文案=「记入错题本」，不再「验算…1-2 分钟」', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')
    const submit = w.find('[data-testid="mistake-submit"]')
    expect(submit.text()).toBe('记入错题本')
    // 弹窗任意文案不得再承诺「1-2 分钟」验算等待
    expect(w.find('[data-testid="mistake-add-form"]').text()).not.toContain('1-2')
  })

  it('api k12RecordMistake 存在且 timeout 为秒级（≤30s，非 grade 的 120s 验算链）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/api/k12.ts'), 'utf8')
    const at = src.indexOf('export function k12RecordMistake')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n}', at))
    const m = body.match(/timeout:\s*([\d_]+)/)
    expect(m).toBeTruthy()
    expect(Number(m?.[1]?.replace(/_/g, ''))).toBeLessThanOrEqual(30_000)
  })

  it('i18n 三语 mistakeAdd.submitting 均不含「1-2」验算等待承诺', async () => {
    const [en, ug] = await Promise.all([import('../i18n/en'), import('../i18n/ug-CN')])
    for (const m of [k12Zh, en.default, ug.default]) {
      expect(String(m.mistakeAdd.submitting)).not.toContain('1-2')
      expect(m.mistakeAdd).toHaveProperty('exists') // 去重命中文案（替代旧「验算通过未记入」）
    }
  })
})
