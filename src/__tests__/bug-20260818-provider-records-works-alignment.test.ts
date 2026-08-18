// 2026-08-18 用户逐项决定（对齐权威原型 app.html）：
//  001 Provider 卡头恒一行 + 状态三态（未测试/失败/成功）+ 眼睛一次性明文回读
//  002 本周该练教材进度卡两态单行（按钮统一「调整进度」）
//  003 全部错题行内动作按钮全部常显（无「…」菜单触发器）
//  004 作品说明文案单行
// 现状（未修复生产代码）不满足以下断言，全部 RED；修复后 GREEN。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..')

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), 'utf8')
}

describe('BUG-20260818-001: Provider 卡头恒一行 + 状态三态 + 眼睛一次性明文回读', () => {
  it('卡头必须移除容器断点换行（对齐 2026-08-17 卡头一行布局决定）', async () => {
    const view = await source('src/views/SettingsView.vue')
    expect(view).not.toMatch(/@container\s*\(max-width:\s*959px\)/)
    const headRule = view.match(/\.hc-provider__card-head\s*\{[^}]*\}/)?.[0] ?? ''
    expect(headRule).toContain('display: flex')
    expect(headRule).not.toContain('grid-template-columns')
  })

  it('卡头连接状态只投影 未测试/成功/失败 三态（测试中… 仅瞬态），不渲染上次测试时间', async () => {
    const view = await source('src/views/SettingsView.vue')
    const statusBlock = view.slice(view.indexOf('hc-provider__connection-status"'), view.indexOf('hc-provider__delete-btn'))
    expect(statusBlock).toMatch(/settings\.llm\.testing/)
    expect(statusBlock).toMatch(/settings\.llm\.testSuccess/)
    expect(statusBlock).toMatch(/settings\.llm\.testFailed/)
    expect(statusBlock).toMatch(/settings\.llm\.untested/)
    expect(view).not.toContain("t('settings.llm.lastTested'")
  })

  it('测试进行中只禁用当前 Provider 的测试按钮（原型只禁当前语义）', async () => {
    const view = await source('src/views/SettingsView.vue')
    expect(view).toContain('testingProviderIds.has(provider.id) ||')
    expect(view).not.toContain('testingProviderIds.has(provider.id) !==')
    expect(view).not.toContain('testingProviderIds.size > 0')
  })

  it('眼睛按钮必须走 toggleApiKeyVisibility（一次性明文回读接线）', async () => {
    const view = await source('src/views/SettingsView.vue')
    const eyeBtn = view.slice(
      view.indexOf('hc-settings__eye-btn'),
      view.indexOf('hc-settings__eye-btn') + 400,
    )
    expect(eyeBtn).toContain('toggleApiKeyVisibility(provider)')
    expect(view).toMatch(/import\s*\{[^}]*readProviderApiKey/)
  })

  it('内置 Provider 编辑表单顺序为 Base URL 左窄列、API Key 右宽列（2026-08-17 批准）', async () => {
    const view = await source('src/views/SettingsView.vue')
    // builtin：视觉顺序对调由 grid order 实现（Base URL order:-1 左窄列，API Key 右宽列）
    expect(view).toContain('.hc-provider__config-grid--builtin .hc-provider__config-url')
    expect(view).toContain('order: -1')
    // custom 900px+：API Key 列比 Base URL 列宽（顺序不变）
    expect(view).toContain('minmax(280px, 1.2fr)')
    expect(view).toContain('minmax(220px, 0.82fr)')
  })
})

describe('BUG-20260818-002: 本周该练教材进度卡两态单行', () => {
  it('missing 卡单行：标题 + 「调整进度」按钮，无长说明文案', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    const missingBlock = panel.slice(panel.indexOf('weekly-progress--missing'), panel.indexOf('weekly-progress--missing') + 1200)
    expect(missingBlock).toContain('调整进度')
    expect(missingBlock).not.toContain('确认当前教材、单元和页码后')
    expect(missingBlock).not.toContain('设置教材进度\n')
  })

  it('进度卡行内布局为 flex 单行（b nowrap、span nowrap + 省略号）', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    const progressRules = [...panel.matchAll(/\.weekly-progress > div \s*\{[\s\S]*?\n\}/g)].map((m) => m[0])
    expect(progressRules.length).toBeGreaterThanOrEqual(1)
    const progressRule = progressRules[progressRules.length - 1]
    expect(progressRule).toContain('display: flex')
    expect(progressRule).not.toContain('display: grid')
    const spanRules = [...panel.matchAll(/\.weekly-progress > div > span \s*\{[\s\S]*?\n\}/g)].map((m) => m[0])
    expect(spanRules.length).toBeGreaterThanOrEqual(1)
    const spanRule = spanRules[spanRules.length - 1]
    expect(spanRule).toContain('white-space: nowrap')
    expect(spanRule).toContain('text-overflow: ellipsis')
  })
})

describe('BUG-20260818-003: 全部错题行内动作按钮全部常显', () => {
  it('全部错题档案行的 K12MistakeReviewMenu 必须 display="visible"（无 … 触发器）', async () => {
    const records = await source('src/features/k12/views/K12RecordsView.vue')
    const mistakesBlock = records.slice(
      records.indexOf('data-testid="mistakes-section"'),
      records.indexOf('data-testid="practicesets-section"'),
    )
    expect(mistakesBlock).toContain('display="visible"')
  })
})

describe('BUG-20260818-004: 作品说明文案单行', () => {
  it('k12cw__desc 必须单行（nowrap + 省略号）', async () => {
    const panel = await source('src/features/k12/views/K12CreativeWorksPanel.vue')
    const descRule = panel.match(/\.k12cw__desc\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(descRule).toContain('white-space: nowrap')
    expect(descRule).toContain('text-overflow: ellipsis')
    expect(panel).toContain(':title="t(\'k12.works.desc\')"')
  })
})