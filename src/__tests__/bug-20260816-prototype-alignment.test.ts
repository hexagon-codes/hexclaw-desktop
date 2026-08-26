// 原型对齐回归合同：回复无框、助手置顶、周练标题与作品列表列数。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..')

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), 'utf8')
}

describe('BUG-20260816-002: 回复消息无框无 ! 图标（对齐原型）', () => {
  it('ChatView 的 --empty 卡片绑定必须排除 live 流式消息', async () => {
    const view = await source('src/views/ChatView.vue')
    expect(view).toMatch(
      /'hc-msg__bubble--empty':\s*!isLiveAssistantMessage\(msg\)\s*&&\s*isEmptyReply\(msg\.content\)/u,
    )
  })
})

describe('BUG-20260816-003: K12 辅导助手锁定置顶（对齐原型 data-pin-locked）', () => {
  it('isScenarioSession 必须带 agentId 模式兜底（agents 未就绪也能置顶）', async () => {
    const list = await source('src/components/chat/SessionList.vue')
    const start = list.indexOf('function isScenarioSession')
    expect(start).toBeGreaterThanOrEqual(0)
    const fn = list.slice(start, list.indexOf('\n}\n', start))
    expect(fn).toContain('matchesInstanceId')
  })
})

describe('BUG-20260816-004: 周练「设置教材进度」标题不折行（对齐原型 b nowrap）', () => {
  it('weekly-progress--missing 的标题 b 必须 white-space:nowrap', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    const match = panel.match(
      /weekly-progress--missing[\s\S]{0,400}?b\s*\{[^}]*white-space:\s*nowrap/u,
    )
    expect(match).not.toBeNull()
  })
})

describe('BUG-20260816-005: 作品列表固定双列投影', () => {
  it('k12cw__list 必须固定两条等宽轨道并禁止 auto-fill', async () => {
    const panel = await source('src/features/k12/views/K12CreativeWorksPanel.vue')
    expect(panel).toMatch(
      /\.k12cw__list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/su,
    )
    expect(panel).not.toContain('repeat(auto-fill')
  })
})

describe('BUG-20260816-006: 到期复习行对齐架构/原型（图 10 + app.html:3104-3109）', () => {
  it('面板到期复习行必须有一键加入练习集动作投影（加入/正在出题/已加入/查看新题）', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    const projection = await source('src/features/k12/practice-generation-projection.ts')
    expect(panel).toContain(
      "import { projectMistakePracticeGeneration } from '../practice-generation-projection'",
    )
    expect(panel).toMatch(/projectMistakePracticeGeneration\(/u)
    expect(projection).toMatch(/加入练习集/u)
    expect(projection).toMatch(/正在出题/u)
    expect(projection).toMatch(/已加入练习集/u)
    expect(panel).toMatch(/查看新题/u)
  })

  it('面板到期复习行必须渲染学科·知识点 kpill（原型 .kpill）', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/item\.subject/u)
    expect(panel).toMatch(/knowledge_point|knowledgePoint/u)
  })

  it('到期复习只直显本周先不练，长期不再复习复用逐题更多菜单', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/本周先不练/u)
    expect(panel).toMatch(/<K12MistakeReviewMenu/u)
    expect(panel).not.toMatch(/<K12MistakeReviewMenu[\s\S]{0,240}?display="visible"/u)
  })

  it('前端 WeeklyPracticeItemDTO 必须带 subject / knowledge_point 字段', async () => {
    const api = await source('src/api/k12.ts')
    const dtoStart = api.indexOf('interface WeeklyPracticeItemDTO')
    expect(dtoStart).toBeGreaterThanOrEqual(0)
    const dto = api.slice(dtoStart, api.indexOf('}\n', dtoStart))
    expect(dto).toMatch(/subject/u)
    expect(dto).toMatch(/knowledge_point/u)
  })
})

describe('BUG-20260816-006 待续项（原型对照：app.html:6833 openGeneratedPractice / .kpill / .stpill.got）', () => {
  it('「查看新题」必须是弹层（新题/来源/依据/答案），不是切 tab', async () => {
    const records = await source('src/features/k12/views/K12RecordsView.vue')
    expect(records).toMatch(/openGeneratedPractice|viewPracticeModal|view-practice-modal|新题/u)
    expect(records).not.toMatch(/sub\.value = 'practiceSets'/u)
  })

  it('面板必须定义 .kpill 样式（对齐原型 pill + 学科色）', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/\.kpill\s*\{/u)
  })

  it('joined 态必须是 .stpill.got 样式 pill（✓ 已加入练习集）', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/\.stpill\.got|rl-status--got/u)
  })

  it('hero meta 对齐原型（app.html:3101）：本周错题/同步巩固 待准备/口算热身 待开始', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/本周错题/u)
    expect(panel).toMatch(/同步巩固/u)
    expect(panel).toMatch(/待准备/u)
    expect(panel).toMatch(/口算热身/u)
    expect(panel).toMatch(/待开始/u)
    // 旧实现（hero meta 轨道名循环）必须消失
    const heroMeta = panel.slice(
      panel.indexOf('weekly-hero__meta'),
      panel.indexOf('</div>', panel.indexOf('weekly-hero__meta')) + 6,
    )
    expect(heroMeta).not.toMatch(/v-for="track in visibleTracks"/u)
  })

  it('会话列表标题对齐原型 .cs-t：13px/400/nowrap/ellipsis', async () => {
    const list = await source('src/components/chat/SessionList.vue')
    const titleCss = list.slice(
      list.indexOf('.hc-sessions__title {'),
      list.indexOf('.hc-sessions__branch-badge'),
    )
    expect(titleCss).toMatch(/font-size:\s*13px/u)
    expect(titleCss).toMatch(/font-weight:\s*400/u)
    expect(titleCss).toMatch(/white-space:\s*nowrap/u)
    expect(titleCss).toMatch(/text-overflow:\s*ellipsis/u)
  })

  it('hero 趋势 pill：面板 trendPill prop 渲染「趋势 ↑ 在进步」，K12RecordsView 已接线', async () => {
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/trendPill/u)
    expect(panel).toMatch(/趋势 ↑ 在进步/u)
    expect(panel).toMatch(/stpill got/u)
    const records = await source('src/features/k12/views/K12RecordsView.vue')
    expect(records).toMatch(/:trend-pill="hasWeeklyTrend"/u)
    expect(records).toMatch(/hasWeeklyTrend/u)
    expect(records).toMatch(/store\.report\?\.trend/u)
  })

  it('掌握状态 pill：DTO 带 mastery_status 且到期复习面板按原型词表投影', async () => {
    const api = await source('src/api/k12.ts')
    expect(api).toMatch(/mastery_status/u)
    const panel = await source('src/features/k12/components/K12WeeklyPracticePanel.vue')
    expect(panel).toMatch(/masteryPill/u)
    expect(panel).toMatch(/证据已掌握/u)
    expect(panel).toMatch(/未掌握/u)
    expect(panel).toMatch(/已重做/u)
    expect(panel).toMatch(/已归档/u)
  })
})
