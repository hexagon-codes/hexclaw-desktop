/**
 * 学情=路由器（PRD §3.11，原型 2613-2631，2026-07-18）：
 * ①标题「学情报告·每月1日自动生成」→「{grade}学习概览 · 从真实批改与复练证据生成」（月报口径退役）；
 * ②瓷片/薄弱条/挫败 CTA 可点 → emit('navigate', target)，外层 K12ChatEnhancement 切学习档案
 *   并把 target 透传给 RecordsView 直达对应对象；
 * ③第四瓷片=练习集待打印（draft 篮 items 求和，自拉 k12ListPracticeSets，不编数）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12InsightPanel from '../views/K12InsightPanel.vue'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({ practiceSpy: vi.fn() }))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [
      {
        record_id: 'm1',
        question: '解方程 2x+15=43',
        knowledge_point: '简易方程',
        error_cause: '等式性质未掌握',
        status: 'new',
        version: 1,
        subject: '数学',
      },
    ],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 11, mastered: 6, reviewing: 4, retried: 1, archived: 0 },
    weak_top3: [
      { knowledge_point: '简易方程', count: 5 },
      { knowledge_point: '小数乘法', count: 3 },
    ],
    month_new_mistakes: 9,
    review_completion_rate: 0.78,
    consecutive_fail_kps: ['简易方程'],
    suggestion: '先做等式性质热身。',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ListPracticeSets: (agent: string, status?: string) => h.practiceSpy(agent, status),
  k12MistakeSheet: vi.fn(),
  k12ExportMd: vi.fn(),
  k12Backup: vi.fn(),
  k12Restore: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

async function mountInsight(props: Record<string, string> = {}) {
  setActivePinia(createPinia())
  const w = mount(K12InsightPanel, {
    props: { agentId: 'k12-tutor-x', ...props },
    global: { plugins: [createPinia(), i18n()] },
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.practiceSpy.mockReset().mockResolvedValue({
    // draft 篮两卷 4+2=6 道
    items: [
      { record_id: 'ps1', status: 'draft', items: [{}, {}, {}, {}] },
      { record_id: 'ps2', status: 'draft', items: [{}, {}] },
    ],
  })
})

describe('学情标题（原型 2613：月报口径退役）', () => {
  it('★有 grade → 「五年级上学习概览」+ 证据来源 note；不再出现「学情报告/每月 1 日」', async () => {
    const w = await mountInsight({ grade: '五年级上' })
    const title = w.find('[data-testid="insight-title"]')
    expect(title.text()).toBe('五年级上学习概览')
    expect(w.text()).toContain('从真实批改与复练证据生成')
    expect(w.text()).not.toContain('学情报告')
    expect(w.text()).not.toContain('每月 1 日自动生成')
  })

  it('无 grade → 通用「学习概览」', async () => {
    const w = await mountInsight()
    expect(w.find('[data-testid="insight-title"]').text()).toBe('学习概览')
  })
})

describe('第四瓷片 · 练习集待打印（原型 2617）', () => {
  it('★draft 篮 items 求和（4+2=6），按 agent+draft 拉取', async () => {
    const w = await mountInsight()
    expect(h.practiceSpy).toHaveBeenCalledWith('k12-tutor-x', 'draft')
    const tile = w.find('[data-testid="insight-tile-practice"]')
    expect(tile.text()).toContain('6')
    expect(tile.text()).toContain('练习集待打印')
  })

  it('拉取失败 → 显示「—」不编数', async () => {
    h.practiceSpy.mockRejectedValue(new Error('boom'))
    const w = await mountInsight()
    expect(w.find('[data-testid="insight-tile-practice"]').text()).toContain('—')
  })
})

describe('学情加载失败', () => {
  it('显示可操作错误并可原地重试，不把失败伪装成空报告', async () => {
    const w = await mountInsight()
    const store = useK12Store()
    store.report = null
    store.reportError = '学情加载失败'
    await flushPromises()

    expect(w.get('[data-testid="insight-error"]').text()).toContain('学情加载失败')
    await w.get('[data-testid="insight-retry"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="insight-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="insight-tile-mastered"]').exists()).toBe(true)
  })
})

describe('路由器出口 · navigate emit（§3.11）', () => {
  it('★瓷片点击：证据已掌握精确预设已掌握，其他目标清理错题筛选', async () => {
    const w = await mountInsight()
    await w.find('[data-testid="insight-tile-semester"]').trigger('click')
    await w.find('[data-testid="insight-tile-mastered"]').trigger('click')
    await w.find('[data-testid="insight-tile-week"]').trigger('click')
    await w.find('[data-testid="insight-tile-practice"]').trigger('click')
    expect(w.emitted('navigate')).toEqual([
      [{ target: 'mistakes', subject: '', status: 'all' }],
      [{ target: 'mistakes', subject: '', status: 'mastered' }],
      [{ target: 'week', subject: '', status: 'all' }],
      [{ target: 'practiceSets', subject: '', status: 'all' }],
    ])
  })

  it('薄弱条按真实错题学科预设学科并清理状态；挫败 CTA 清理两维筛选', async () => {
    const w = await mountInsight()
    await w.find('[data-testid="insight-weak-bar"]').trigger('click')
    await w.find('[data-testid="insight-fail-cta"]').trigger('click')
    expect(w.emitted('navigate')).toEqual([
      [{ target: 'mistakes', subject: '数学', status: 'all' }],
      [{ target: 'week', subject: '', status: 'all' }],
    ])
  })

  it('瓷片可键盘触达（role=button + tabindex + enter）', async () => {
    const w = await mountInsight()
    const tile = w.find('[data-testid="insight-tile-week"]')
    expect(tile.attributes('role')).toBe('button')
    expect(tile.attributes('tabindex')).toBe('0')
    await tile.trigger('keydown.enter')
    expect(w.emitted('navigate')).toEqual([[{ target: 'week', subject: '', status: 'all' }]])
  })
})

describe('K12ChatEnhancement 接线（源码契约：外层归其他会话活跃区，最小改动只验绑定）', () => {
  const src = readFileSync(resolve(__dirname, '../views/K12ChatEnhancement.vue'), 'utf-8')
  it('InsightPanel navigate 保留结构化 target/subject/status，RecordsView 接收完整下钻条件', () => {
    expect(src, 'navigate 出口不应丢掉 target').toContain('@navigate="goRecords"')
    expect(src, '年级应透传给学情标题').toContain(':grade="grade || undefined"')
    expect(src).toContain(':target="recordsNavigation.target"')
    expect(src).toContain(':subject="recordsNavigation.subject"')
    expect(src).toContain(':status="recordsNavigation.status"')
    expect(src).toContain(':navigation="recordsNavigation"')
  })
})
