/**
 * BUG-20260712-F（视觉评审定案 → 回归锁）：「记一条错题」弹窗题目/错处仅单行 input，
 * 应用题/古诗/英语整句输完看不见全文——录入是错题本的捕获时刻，此处摩擦直接流失条目。
 *
 * 定案（原型 app.html openAddMistake 已同步更新，实现不得漂移）：
 *  ① 题目=英雄字段：多行 textarea（rows≥3、纵向可拉），支持整段粘贴、换行保留；
 *  ② 孩子错处：多行 textarea（rows≥2）；
 *  ③ 知识点保持单行（短语字段）+「留空由 AI 归纳」；
 *  ④ textarea 内 Enter=换行不误触提交；⌘/Ctrl+Enter 提交。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({ gradeSpy: vi.fn() }))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: (req: unknown) => h.gradeSpy(req),
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

async function openDialog() {
  const w = mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
  await flushPromises()
  await w.find('[data-testid="mistake-add-open"]').trigger('click')
  return w
}

const LONG_PROBLEM = '一个梯形果园，上底 120 米，下底 180 米，高 80 米。\n每棵果树占地 12 平方米，这个果园一共能种多少棵果树？\n（先求面积，再求棵数）'

describe('BUG-20260712-F：记一条错题弹窗必须适配长内容（原型 openAddMistake 定案）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.gradeSpy.mockReset().mockResolvedValue({
      solution: 'x', verdict: 'agree', evidence_type: 'program', badge: 'ok',
      correct: false, out_of_scope: false, record_created: true, record_id: 'm-1',
    })
  })

  it('★题目=多行 textarea（rows≥3）、错处=多行 textarea（rows≥2），多行内容原样透传验算管道', async () => {
    const w = await openDialog()

    const problem = w.find('[data-testid="mistake-problem"]')
    expect(problem.element.tagName, '题目必须是 textarea（单行 input=捕获时刻流失）').toBe('TEXTAREA')
    expect(Number(problem.attributes('rows') ?? 0)).toBeGreaterThanOrEqual(3)

    const answer = w.find('[data-testid="mistake-answer"]')
    expect(answer.element.tagName, '孩子错处必须是 textarea').toBe('TEXTAREA')
    expect(Number(answer.attributes('rows') ?? 0)).toBeGreaterThanOrEqual(2)

    w.find('[data-testid="mistake-subject"]').findComponent(HcSelect).vm.$emit('update:modelValue', '数学')
    await problem.setValue(LONG_PROBLEM)
    await answer.setValue('面积算成了 (120+180)×80=24000\n忘了除以 2')
    await w.find('[data-testid="mistake-submit"]').trigger('click')
    await flushPromises()

    expect(h.gradeSpy).toHaveBeenCalledWith(expect.objectContaining({
      problem: LONG_PROBLEM, // 换行必须原样保留
    }))
  })

  it('⌘Enter 在题目 textarea 内直接提交（Enter=换行不误触）', async () => {
    const w = await openDialog()
    w.find('[data-testid="mistake-subject"]').findComponent(HcSelect).vm.$emit('update:modelValue', '数学')
    const problem = w.find('[data-testid="mistake-problem"]')
    await problem.setValue('3.8×3')

    await problem.trigger('keydown', { key: 'Enter' }) // 裸 Enter：不提交
    await flushPromises()
    expect(h.gradeSpy).not.toHaveBeenCalled()

    await problem.trigger('keydown', { key: 'Enter', metaKey: true }) // ⌘Enter：提交
    await flushPromises()
    expect(h.gradeSpy).toHaveBeenCalledTimes(1)
  })
})
