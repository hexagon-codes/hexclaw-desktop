import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const AGENT = 'k12-fidelity-ming'
const SESSION = 'k12-fidelity-session'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-fidelity/evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')

type SurfaceName = 'k12-weekly-current' | 'k12-works'

interface GeometryTarget {
  name: string
  selector: string
  all?: boolean
}

interface Surface {
  name: SurfaceName
  openReference(page: Page): Promise<void>
  openImplementation(page: Page): Promise<void>
  referenceGeometry: GeometryTarget[]
  implementationGeometry: GeometryTarget[]
}

interface ShellLayerCandidate {
  name: string
  selector: string
  pseudo?: '::before' | '::after'
}

const referenceShellLayers: ShellLayerCandidate[] = [
  { name: 'prototype-texture', selector: '.app', pseudo: '::after' },
  { name: 'prototype-glow', selector: '.mn-glow' },
]

const implementationShellLayers: ShellLayerCandidate[] = [
  { name: 'global-texture', selector: '.hc-app', pseudo: '::after' },
  { name: 'layout-texture', selector: '.hc-app__body', pseudo: '::after' },
  { name: 'global-glow', selector: '.hc-app__content', pseudo: '::before' },
  { name: 'layout-glow', selector: '.hc-app__glow' },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function verifiedWeeklyItem(
  itemID: string,
  position: number,
  sourceRef: string,
  prompt: string,
  evidence: string,
) {
  return {
    item_id: itemID,
    position,
    plan_section: 'due_review',
    source_kind: 'mistake',
    generation_method: 'original',
    source_ref: sourceRef,
    verification: {
      status: 'verified',
      evidence_refs: [evidence],
    },
    prompt_markdown: prompt,
  }
}

const weeklyPlan = {
  plan_id: 'weekly-2026-30',
  agent: AGENT,
  revision: 11,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft',
  settings_revision: 7,
  curriculum_progress_revision: 4,
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      arithmetic_batch: null,
      items: [
        verifiedWeeklyItem(
          'weekly-item-1',
          1,
          'mistake-apple',
          '苹果每千克 4.2 元，买 3 千克共多少钱？',
          '小数乘法错题 · 连续错 2 次',
        ),
        verifiedWeeklyItem(
          'weekly-item-2',
          2,
          'mistake-equation',
          '解方程：2x + 15 = 43。',
          '简易方程错题 · 移项符号错',
        ),
        verifiedWeeklyItem(
          'weekly-item-3',
          3,
          'mistake-believe',
          '默写单词：believe。',
          'Unit 4 听写错题',
        ),
        verifiedWeeklyItem(
          'weekly-item-4',
          4,
          'mistake-poem',
          '补全诗句：梅＿＿逊雪三分白。',
          '古诗默写错题',
        ),
        verifiedWeeklyItem(
          'weekly-item-5',
          5,
          'mistake-fraction',
          '8 的 1/4 的 4/5 是多少？',
          '分数乘法错题',
        ),
        verifiedWeeklyItem(
          'weekly-item-6',
          6,
          'mistake-decimal',
          '口算：4 ÷ 0.5。',
          '小数除法错题',
        ),
      ],
    },
    {
      plan_section: 'textbook_consolidation',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
  ],
  manual_track_recommendations: {
    textbook_consolidation: {
      availability: 'available',
      selected_item_count: 5,
      recommended_item_count: 5,
      min_item_count: 1,
      max_item_count: 10,
    },
    arithmetic_warmup: {
      availability: 'available',
      selected_item_count: 10,
      recommended_item_count: 10,
      min_item_count: 1,
      max_item_count: 20,
    },
  },
  created_at: '2026-07-20T00:00:00+08:00',
  updated_at: '2026-07-20T00:00:00+08:00',
}

function feedback(id: string, type: 'writing' | 'art', visibleEvidence: string[]) {
  return {
    feedback_id: id,
    feedback_type: type,
    evidence_refs: visibleEvidence.map((_, index) => `evidence-${id}-${index + 1}`),
    visible_evidence: visibleEvidence,
    affirmation: '这次作品已经保存了清楚、可见的优点。',
    parent_guidance: '可以请孩子说说自己最满意的部分。',
    next_step: '下一次只尝试改进一个小地方。',
    source_snapshot: {
      source: 'ai',
      method_ref: 'k12-creative-feedback-v1',
      capability: 'creative-work-feedback',
    },
  }
}

const creativeWorks = [
  {
    work_id: 'WRITING-20260715-001',
    work_type: 'writing',
    display_name: '《春天的校园》',
    content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-WRITING-20260715-001',
      status: 'succeeded',
      feedback: feedback('feedback-writing', 'writing', [
        '切题：校园春景',
        '结构：三段',
        '表达：有一处可提升',
      ]),
    },
  },
  {
    work_id: 'ART-20260716-001',
    work_type: 'art',
    display_name: '《雨后的校园》',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260716-001',
      status: 'succeeded',
      feedback: feedback('feedback-art-watercolor', 'art', [
        '构图：主体偏右',
        '色彩：冷暖有层次',
        '线条：边缘清楚',
      ]),
    },
  },
  {
    work_id: 'ART-20260717-002',
    work_type: 'art',
    display_name: '《桌上的水杯》',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260717-002',
      status: 'failed',
      failure_message: '点评生成失败',
    },
  },
]

async function installImplementationMocks(page: Page) {
  await page.addInitScript(
    ({ agent, session }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem('hc-theme', 'light')
    },
    { agent: AGENT, session: SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'fidelity-fixture' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const requestURL = new URL(request.url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/api/v1/config' && method === 'GET') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (apiPath === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: AGENT,
            display_name: '小明的辅导助手',
            description: '五年级下 · 各学科教材独立绑定',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.learner_id': 'learner-fidelity-ming',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
            },
          },
        ],
        total: 1,
        default: AGENT,
      })
    }
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: SESSION,
            title: '小明的辅导助手',
            created_at: '2026-07-20T00:00:00+08:00',
            updated_at: '2026-07-20T00:00:00+08:00',
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (
      apiPath === `/api/v1/sessions/${SESSION}/messages` ||
      apiPath === `/api/v1/sessions/${SESSION}/artifacts`
    ) {
      return json(route, { messages: [], artifacts: [], total: 0 })
    }
    if (apiPath === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: [],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, {
        progress: {
          progress_id: 'progress-fidelity',
          agent: AGENT,
          subject: 'math',
          revision: 4,
          textbook_binding_id: 'pep-5b',
          textbook_edition: '人教版',
          textbook_version: '2022',
          title: '义务教育教科书数学',
          volume: '五年级下册',
          unit_id: 'unit-4',
          unit_title: '第4单元「分数的意义和性质」',
          verified_page_from: 45,
          verified_page_to: 62,
          page_verification_status: 'verified',
          segment_refs: ['segment-45-62'],
          evidence_source: 'parent_confirmed',
          confirmed_at: '2026-07-20T00:00:00+08:00',
          created_at: '2026-07-20T00:00:00+08:00',
          updated_at: '2026-07-20T00:00:00+08:00',
        },
      })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: AGENT,
        revision: 7,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: '2026-07-20T00:00:00+08:00',
        updated_at: '2026-07-20T00:00:00+08:00',
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: weeklyPlan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, {
        items: [
          {
            snapshot_id: 'snapshot-2026-29',
            plan_id: 'weekly-2026-29',
            artifact_id: 'artifact-2026-29',
            iso_week_year: 2026,
            iso_week_number: 29,
            timezone: 'Asia/Shanghai',
            local_start_date: '2026-07-13',
            local_end_date: '2026-07-19',
            item_count: 8,
            correct_count: 7,
            wrong_count: 1,
            archived_at: '2026-07-20T00:00:00+08:00',
          },
        ],
        next_cursor: null,
      })
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: creativeWorks })
    }
    if (
      apiPath === '/api/k12/mistakes' ||
      apiPath === '/api/k12/review-queue' ||
      apiPath === '/api/k12/accumulation' ||
      apiPath === '/api/k12/accumulations' ||
      apiPath === '/api/k12/practice-sets'
    ) {
      return json(route, { items: [] })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
        suggestion: '',
      })
    }
    if (apiPath === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function openReferenceRecords(page: Page, tab: number) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate((recordsTab) => {
    const api = window as typeof window & {
      goRecords?: (learner: string, tab: number) => void
      k12BookTab?: (tab: number) => void
    }
    api.goRecords?.('ming', recordsTab)
    api.k12BookTab?.(recordsTab)
  }, tab)
  await expect(page.locator('#k12ViewRecords')).toBeVisible()
}

async function openImplementationRecords(page: Page, tab: 'week' | 'works') {
  await page.goto(
    `${IMPLEMENTATION_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  const scenarioTabs = page.locator('.k12enh-seg')
  await expect(scenarioTabs.getByRole('tab', { name: '学习档案', exact: true })).toBeVisible()
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
  await expect(page.locator('.k12rec')).toBeVisible()
  if (tab === 'week') {
    await expect(page.getByTestId('week-section')).toBeVisible()
    await expect(page.locator('.weekly-hero')).toBeVisible()
  } else {
    await page.getByTestId('subtab-works').click()
    await expect(page.getByTestId('works-section')).toBeVisible()
    await expect(page.getByTestId('cw-list')).toBeVisible()
  }
}

const surfaces: Surface[] = [
  {
    name: 'k12-weekly-current',
    openReference: async (page) => {
      await openReferenceRecords(page, 0)
      await expect(page.locator('#k12BookPanel0')).toBeVisible()
    },
    openImplementation: async (page) => openImplementationRecords(page, 'week'),
    referenceGeometry: [
      { name: 'object-tabs', selector: '#k12BookTabs' },
      { name: 'period-tabs', selector: '#k12BookPanel0 .k12-week-view-tabs' },
      { name: 'period-toolbar', selector: '#k12BookPanel0 .k12-secondary-toolbar' },
      { name: 'progress', selector: '#k12BookPanel0 .rc-week-progress' },
      { name: 'hero', selector: '#k12BookPanel0 .rc-week-hero' },
      { name: 'items', selector: '#k12BookPanel0 .rc-week-hero .resource-row', all: true },
    ],
    implementationGeometry: [
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs' },
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs' },
      { name: 'period-toolbar', selector: '.weekly-toolbar' },
      { name: 'progress', selector: '.weekly-progress' },
      { name: 'hero', selector: '.weekly-hero' },
      { name: 'tracks', selector: '.weekly-track', all: true },
      { name: 'items', selector: '.weekly-item', all: true },
    ],
  },
  {
    name: 'k12-works',
    openReference: async (page) => {
      await openReferenceRecords(page, 4)
      await expect(page.locator('#k12BookPanel4')).toBeVisible()
    },
    openImplementation: async (page) => openImplementationRecords(page, 'works'),
    referenceGeometry: [
      { name: 'object-tabs', selector: '#k12BookTabs' },
      { name: 'overview', selector: '#k12BookPanel4 .practice-overview' },
      { name: 'filters', selector: '#k12CreativeWorkFilters' },
      { name: 'rules', selector: '#k12BookPanel4 .notice-accent' },
      { name: 'list', selector: '#k12CreativeWorkList' },
      { name: 'cards', selector: '#k12CreativeWorkList .creative-work-card', all: true },
    ],
    implementationGeometry: [
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs' },
      { name: 'overview', selector: '.k12cw__overview' },
      { name: 'filters', selector: '.k12cw__filter' },
      { name: 'rules', selector: '.k12cw__rules' },
      { name: 'list', selector: '.k12cw__list' },
      { name: 'cards', selector: '.k12cw__card', all: true },
    ],
  },
]

async function geometry(page: Page, targets: GeometryTarget[]) {
  const result: Record<string, unknown> = {}
  for (const target of targets) {
    result[target.name] = await page.locator(target.selector).evaluateAll(
      (elements, options: { all: boolean }) => {
        const selected = options.all ? elements : elements.slice(0, 1)
        return selected.map((element) => {
          const node = element as HTMLElement
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            tag: node.tagName.toLowerCase(),
            className: node.className,
            text: node.innerText.replace(/\s+/g, ' ').trim().slice(0, 240),
            rect: {
              x: Number(rect.x.toFixed(2)),
              y: Number(rect.y.toFixed(2)),
              width: Number(rect.width.toFixed(2)),
              height: Number(rect.height.toFixed(2)),
            },
            style: {
              display: style.display,
              position: style.position,
              boxSizing: style.boxSizing,
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              color: style.color,
              borderTopWidth: style.borderTopWidth,
              borderRightWidth: style.borderRightWidth,
              borderBottomWidth: style.borderBottomWidth,
              borderLeftWidth: style.borderLeftWidth,
              borderRadius: style.borderRadius,
              boxShadow: style.boxShadow,
              padding: style.padding,
              margin: style.margin,
              gap: style.gap,
              gridTemplateColumns: style.gridTemplateColumns,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
            },
          }
        })
      },
      { all: target.all === true },
    )
  }
  return result
}

async function shellLayers(page: Page, candidates: ShellLayerCandidate[]) {
  return page.evaluate((layerCandidates) => {
    return layerCandidates.map((candidate) => {
      const element = document.querySelector(candidate.selector)
      if (!element) {
        return {
          ...candidate,
          found: false,
          active: false,
          kind: 'none',
        }
      }
      const style = getComputedStyle(element, candidate.pseudo)
      const backgroundImage = style.backgroundImage
      const kind = backgroundImage.includes('image/svg+xml')
        ? 'texture'
        : backgroundImage.includes('radial-gradient')
          ? 'glow'
          : 'none'
      const active =
        style.content !== 'none' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        backgroundImage !== 'none'
      return {
        ...candidate,
        found: true,
        active,
        kind,
        style: {
          content: style.content,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage,
          backgroundBlendMode: style.backgroundBlendMode,
          mixBlendMode: style.mixBlendMode,
          position: style.position,
          inset: style.inset,
          top: style.top,
          right: style.right,
          bottom: style.bottom,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
        },
      }
    })
  }, candidates)
}

async function captureSurface(
  referencePage: Page,
  implementationPage: Page,
  surface: Surface,
  testInfo: TestInfo,
) {
  await surface.openReference(referencePage)
  await surface.openImplementation(implementationPage)
  await freezeVisualState(referencePage)
  await freezeVisualState(implementationPage)

  const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.name)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const implementationPath = path.join(outputDir, 'implementation.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry.json')
  const reportPath = path.join(outputDir, 'diff-report.json')

  await referencePage.screenshot({
    path: referencePath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  })
  await implementationPage.screenshot({
    path: implementationPath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  })

  const [referenceGeometry, implementationGeometry, referenceLayers, implementationLayers] =
    await Promise.all([
      geometry(referencePage, surface.referenceGeometry),
      geometry(implementationPage, surface.implementationGeometry),
      shellLayers(referencePage, referenceShellLayers),
      shellLayers(implementationPage, implementationShellLayers),
    ])
  await writeFile(
    geometryPath,
    `${JSON.stringify(
      {
        surface: surface.name,
        viewport: referencePage.viewportSize(),
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        reference: referenceGeometry,
        implementation: implementationGeometry,
        shellLayers: {
          reference: referenceLayers,
          implementation: implementationLayers,
        },
      },
      null,
      2,
    )}\n`,
  )

  const { stdout } = await execFileAsync('python3', [
    PIXEL_DIFF_TOOL,
    referencePath,
    implementationPath,
    diffPath,
    String(PIXEL_THRESHOLD),
  ])
  const diffReport = JSON.parse(stdout.trim()) as {
    changed_pixel_ratio: number
    changed_pixels: number
    total_pixels: number
    changed_bbox: number[] | null
  }
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        surface: surface.name,
        referenceURL: REFERENCE_URL,
        implementationURL: IMPLEMENTATION_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
        ...diffReport,
      },
      null,
      2,
    )}\n`,
  )

  await testInfo.attach(`${surface.name}-reference`, {
    body: await readFile(referencePath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-implementation`, {
    body: await readFile(implementationPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-pixel-diff`, {
    body: await readFile(diffPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-geometry`, {
    body: await readFile(geometryPath),
    contentType: 'application/json',
  })

  expect
    .soft(
      diffReport.changed_pixel_ratio,
      `${surface.name} changed ${diffReport.changed_pixels}/${diffReport.total_pixels} pixels; ` +
        `evidence=${outputDir}`,
    )
    .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)

  const referenceTextureCount = referenceLayers.filter(
    (layer) => layer.active && layer.kind === 'texture',
  ).length
  const implementationTextureCount = implementationLayers.filter(
    (layer) => layer.active && layer.kind === 'texture',
  ).length
  const referenceGlowCount = referenceLayers.filter(
    (layer) => layer.active && layer.kind === 'glow',
  ).length
  const implementationGlowCount = implementationLayers.filter(
    (layer) => layer.active && layer.kind === 'glow',
  ).length

  expect
    .soft(
      implementationTextureCount,
      `${surface.name} shell texture exact-set differs from prototype; evidence=${geometryPath}`,
    )
    .toBe(referenceTextureCount)
  expect
    .soft(
      implementationGlowCount,
      `${surface.name} shell glow exact-set differs from prototype; evidence=${geometryPath}`,
    )
    .toBe(referenceGlowCount)
}

test.describe('feat/v0.5.0-k12-parent-tutor prototype screenshot fidelity', () => {
  test('K12 priority surfaces preserve paired screenshots, visible diff and geometry', async ({
    browser,
  }, testInfo) => {
    const referencePage = await browser.newPage()
    const implementationPage = await browser.newPage()
    await installImplementationMocks(implementationPage)
    try {
      for (const surface of surfaces) {
        await captureSurface(referencePage, implementationPage, surface, testInfo)
      }
    } finally {
      await Promise.all([referencePage.close(), implementationPage.close()])
    }
  })
})
