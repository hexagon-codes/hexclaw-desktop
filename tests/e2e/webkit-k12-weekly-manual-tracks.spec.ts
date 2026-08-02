import { expect, test, type Page, type Route } from '@playwright/test'

const AGENT = 'mingming'
const OTHER_AGENT = 'xiaohong'

const profile = {
  name: AGENT,
  display_name: '小明的辅导助手',
  description: '五年级下辅导',
  provider: '',
  model: '',
  metadata: {
    scenario: 'k12-tutor',
    avatar: '🎓',
    'k12.child_name': '小明',
    'k12.grade_term': '五年级下',
    'k12.textbook_edition': '人教版',
  },
}

const otherProfile = {
  ...profile,
  name: OTHER_AGENT,
  display_name: '小红的辅导助手',
  metadata: {
    ...profile.metadata,
    'k12.child_name': '小红',
  },
}

const progress = {
  progress_id: 'progress-1',
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
  confirmed_at: '2026-07-20T00:00:00Z',
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

const settings = {
  agent: AGENT,
  revision: 7,
  timezone: 'Asia/Shanghai',
  due_review_enabled: true,
  textbook_consolidation_enabled: false,
  textbook_consolidation_tier: 'standard',
  arithmetic_warmup_enabled: false,
  arithmetic_minutes: 2,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

function weeklyPlan(revision = 11, agent = AGENT) {
  return {
    plan_id: 'weekly-30',
    agent,
    revision,
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
    tracks: [{ plan_section: 'due_review', status: 'ready', items: [] }],
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
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installMocks(page: Page) {
  const syncBodies: unknown[] = []
  const arithmeticBodies: unknown[] = []
  const weeklyAgents = new Set<string>()
  let plan = weeklyPlan()

  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hc-theme', 'light')
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'test' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()
    const requestedAgent = url.searchParams.get('agent') || AGENT

    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (path === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (path === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (path === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [profile, otherProfile],
        total: 2,
        default: AGENT,
      })
    }
    if (path === '/api/v1/sessions' && method === 'GET') {
      return json(route, { sessions: [], total: 0 })
    }

    if (path === '/api/k12/curriculum-progress' && method === 'GET') {
      weeklyAgents.add(requestedAgent)
      return json(route, { progress: { ...progress, agent: requestedAgent } })
    }
    if (path === '/api/k12/weekly-practice/settings' && method === 'GET') {
      weeklyAgents.add(requestedAgent)
      return json(route, { ...settings, agent: requestedAgent })
    }
    if (path === '/api/k12/weekly-practice/plans' && method === 'POST') {
      const body = request.postDataJSON() as { agent?: string }
      const agent = body.agent || requestedAgent
      weeklyAgents.add(agent)
      plan = weeklyPlan(plan.revision, agent)
      return json(route, { plan, replayed: false }, 201)
    }
    if (path === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, {
        items: [
          {
            snapshot_id: 'snapshot-29',
            plan_id: 'weekly-29',
            artifact_id: 'artifact-29',
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
    if (
      path === '/api/k12/weekly-practice/plans/weekly-30/tracks/textbook_consolidation/prepare' &&
      method === 'POST'
    ) {
      syncBodies.push(request.postDataJSON())
      plan = weeklyPlan(12)
      return json(route, { plan, replayed: false }, 201)
    }
    if (
      path === '/api/k12/weekly-practice/plans/weekly-30/arithmetic-batches' &&
      method === 'POST'
    ) {
      arithmeticBodies.push(request.postDataJSON())
      return json(
        route,
        {
          batch: {
            batch_id: 'batch-30',
            plan_id: 'weekly-30',
            plan_revision: plan.revision,
            state: 'ready',
            items: [],
          },
          replayed: false,
        },
        201,
      )
    }
    if (path === '/api/k12/mistakes' || path === '/api/k12/review-queue') {
      return json(route, { items: [] })
    }
    if (path === '/api/k12/insight-report') {
      return json(route, {
        trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
        weak_top3: [],
        month_new_mistakes: 0,
        review_completion_rate: 0,
        consecutive_fail_kps: [],
        suggestion: '',
      })
    }
    if (
      path === '/api/k12/accumulations' ||
      path === '/api/k12/practice-sets' ||
      path === '/api/k12/creative-works'
    ) {
      return json(route, { items: [] })
    }
    if (path.startsWith('/api/k12/')) return json(route, { items: [] })
    return json(route, {})
  })

  return { syncBodies, arithmeticBodies, weeklyAgents }
}

async function openWeeklyRecords(page: Page, agent: string, title: string) {
  await page.goto(`/chat?role=${agent}&roleTitle=${encodeURIComponent(title)}`)
  const scenarioTabs = page.getByRole('tablist', { name: '辅导助手功能' })
  await expect(scenarioTabs.getByRole('tab', { name: '学习档案', exact: true })).toBeVisible()
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
  await expect(page.getByTestId('week-section')).toBeVisible()
}

async function tabStyle(tab: ReturnType<Page['locator']>) {
  return tab.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      appearance: style.appearance,
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      boxShadow: style.boxShadow,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontStyle: style.fontStyle,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
}

/**
 * `K12BookTabs` intentionally animates hover color/background for 150ms.
 * Read the shared contract only after the browser has painted the hover and
 * all element-local transitions have settled; sampling the first tab after
 * 150ms but the second immediately compares two different visual states.
 */
async function settledHoverTabStyle(tab: ReturnType<Page['locator']>) {
  await tab.hover()
  await tab.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
  )
  await expect
    .poll(() =>
      tab.evaluate((element) =>
        element
          .getAnimations()
          .every(
            (animation) => animation.playState !== 'running' && animation.playState !== 'pending',
          ),
      ),
    )
    .toBe(true)
  return tabStyle(tab)
}

test.describe('BUG-20260727-005 weekly manual tracks @ WebKit', () => {
  test('shared current/history tabs and disabled-auto manual commands remain operable', async ({
    page,
  }) => {
    const requests = await installMocks(page)
    await page.goto(`/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`)

    const scenarioTabs = page.getByRole('tablist', { name: '辅导助手功能' })
    await expect(scenarioTabs.getByRole('tab', { name: '学习档案', exact: true })).toBeVisible()
    await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
    await expect(page.getByTestId('week-section')).toBeVisible()

    const weeklyTabs = page.getByRole('tablist', { name: '本周该练视图' })
    await expect(weeklyTabs).toHaveClass(/k12-book-tabs/)
    await expect(weeklyTabs.getByRole('tab', { name: '本周', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await weeklyTabs.getByRole('tab', { name: '历史', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '历史周练' })).toContainText('2026年第29周')
    await weeklyTabs.getByRole('tab', { name: '本周', exact: true }).click()

    await expect(page.getByText('本周暂时没有需要复习的错题', { exact: true })).toBeVisible()
    await expect(page.locator('[data-textbook-consolidation-state]')).toContainText('同步巩固')
    await expect(page.locator('[data-arithmetic-state]')).toContainText('口算热身')

    const textbookOptions = page.getByRole('group', { name: '同步巩固题数' })
    const textbookCount = textbookOptions.getByRole('spinbutton')
    await expect(textbookCount).toHaveAttribute('min', '1')
    await expect(textbookCount).toHaveAttribute('max', '10')
    await textbookCount.fill('8')
    await expect(textbookCount).toHaveValue('8')
    await page.locator('[data-consolidation-action]').click()
    await expect.poll(() => requests.syncBodies.length).toBe(1)
    expect(requests.syncBodies[0]).toEqual({
      plan_revision: 11,
      item_count: 8,
      idempotency_key: expect.any(String),
    })

    const arithmeticOptions = page.getByRole('group', { name: '口算热身题数' })
    const arithmeticCount = arithmeticOptions.getByRole('spinbutton')
    await expect(arithmeticCount).toHaveAttribute('min', '1')
    await expect(arithmeticCount).toHaveAttribute('max', '20')
    await arithmeticCount.fill('15')
    await expect(arithmeticCount).toHaveValue('15')
    await page.locator('[data-arithmetic-action]').click()
    await expect.poll(() => requests.arithmeticBodies.length).toBe(1)
    expect(requests.arithmeticBodies[0]).toEqual({
      plan_revision: 12,
      item_count: 15,
      idempotency_key: expect.any(String),
    })
  })

  test('[K12-WEEKLY-045] shared tabs retain WebKit states across keyboard, resize, and two child contexts', async ({
    page,
  }) => {
    const requests = await installMocks(page)
    await openWeeklyRecords(page, AGENT, '小明的辅导助手')

    const recordsTabs = page.getByRole('tablist', { name: '学习档案' })
    const weeklyTabs = page.getByRole('tablist', { name: '本周该练视图' })
    const recordsCurrent = recordsTabs.getByRole('tab', { name: /本周该练/ })
    const recordsInactive = recordsTabs.getByRole('tab', { name: /全部错题/ })
    const weeklyCurrent = weeklyTabs.getByRole('tab', { name: '本周', exact: true })
    const weeklyHistory = weeklyTabs.getByRole('tab', { name: '历史', exact: true })

    const inactiveStyles = await tabStyle(weeklyHistory)
    const recordsInactiveStyles = await tabStyle(recordsInactive)
    expect(inactiveStyles).toEqual(recordsInactiveStyles)
    expect(inactiveStyles).toMatchObject({
      appearance: 'none',
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      boxShadow: 'none',
    })
    expect(await tabStyle(weeklyCurrent)).toEqual(await tabStyle(recordsCurrent))

    const weeklyHover = await settledHoverTabStyle(weeklyHistory)
    const recordsHover = await settledHoverTabStyle(recordsInactive)
    expect(weeklyHover).toEqual(recordsHover)

    await weeklyCurrent.focus()
    await page.keyboard.press('Alt+Tab')
    await expect(weeklyHistory).toBeFocused()
    expect(await weeklyHistory.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
    const weeklyFocus = await tabStyle(weeklyHistory)
    await recordsCurrent.focus()
    await page.keyboard.press('Alt+Tab')
    await expect(recordsInactive).toBeFocused()
    expect(await recordsInactive.evaluate((element) => element.matches(':focus-visible'))).toBe(
      true,
    )
    const recordsFocus = await tabStyle(recordsInactive)
    expect({
      outlineStyle: weeklyFocus.outlineStyle,
      outlineWidth: weeklyFocus.outlineWidth,
    }).toEqual({
      outlineStyle: recordsFocus.outlineStyle,
      outlineWidth: recordsFocus.outlineWidth,
    })

    await weeklyHistory.focus()
    await page.keyboard.press('Enter')
    await expect(weeklyHistory).toHaveAttribute('aria-selected', 'true')
    await weeklyCurrent.focus()
    await page.keyboard.press('Space')
    await expect(weeklyCurrent).toHaveAttribute('aria-selected', 'true')

    for (const viewport of [
      { width: 520, height: 760 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      await expect(recordsTabs).toBeVisible()
      await expect(weeklyTabs).toBeVisible()
      expect(await tabStyle(weeklyHistory)).toMatchObject({
        appearance: 'none',
        borderTopWidth: '0px',
        boxShadow: 'none',
      })
    }

    await page.mouse.move(0, 0)
    await expect.poll(() => tabStyle(weeklyHistory)).toEqual(inactiveStyles)
    const firstChildIdle = await tabStyle(weeklyHistory)
    await openWeeklyRecords(page, OTHER_AGENT, '小红的辅导助手')
    const otherWeeklyTabs = page.getByRole('tablist', { name: '本周该练视图' })
    const otherHistory = otherWeeklyTabs.getByRole('tab', { name: '历史', exact: true })
    await expect.poll(() => tabStyle(otherHistory)).toEqual(firstChildIdle)
    expect(requests.weeklyAgents).toEqual(new Set([AGENT, OTHER_AGENT]))
  })
})
