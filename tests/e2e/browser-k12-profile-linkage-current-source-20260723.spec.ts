import { expect, test, type Page, type Route } from '@playwright/test'
import { mkdirSync } from 'node:fs'

test.use({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
})

const K12_AGENT = 'k12-tutor-profile-linkage'
const ARTIFACT_DIR =
  process.env.HEX_K12_PROFILE_ARTIFACT_DIR || 'tests/e2e/screenshots/current-source'
const K12_PROFILE = {
  name: K12_AGENT,
  display_name: '小明的辅导助手 · 五年级',
  description: '五年级下 · 各学科教材独立绑定 · 按年级边界讲解',
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installK12ProfileMocks(page: Page) {
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
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()

    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
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
      return json(route, { agents: [K12_PROFILE], total: 1, default: K12_AGENT })
    }
    if (path === `/api/v1/agents/${K12_AGENT}` && method === 'PUT') {
      return json(route, { message: 'updated' })
    }
    if (path === '/api/k12/profile' && method === 'PUT') {
      return json(route, {
        child_name: '小明',
        grade_term: '六年级下',
        textbook_edition: '人教版',
      })
    }
    if (path === '/api/k12/cron/reconcile-defaults' && method === 'POST') {
      return json(route, {
        provisioned: [
          { kind: 'weekly-sheet', name: 'weekly', schedule: '0 19 * * 5', job_id: 'j1' },
          { kind: 'return-reminder', name: 'return', schedule: '0 20 * * 5', job_id: 'j2' },
          {
            kind: 'semester-spring',
            name: 'spring',
            schedule: '0 9 1 2 *',
            job_id: 'j3',
          },
          { kind: 'semester-fall', name: 'fall', schedule: '0 9 1 9 *', job_id: 'j4' },
        ],
      })
    }
    if (path === '/api/k12/mistakes') return json(route, { items: [] })
    if (path === '/api/k12/review-queue') return json(route, { items: [] })

    return json(route, {})
  })
}

test.describe('K12 建档二级联动 current-source contract', () => {
  test.beforeAll(() => mkdirSync(ARTIFACT_DIR, { recursive: true }))

  test('RED control catches the former single composite grade-term selector', async ({ page }) => {
    test.skip(
      process.env.HEX_K12_PROFILE_RED !== '1',
      'negative control only runs when explicitly proving the old selector is rejected',
    )
    await page.setContent(`
      <div class="k12pf__row--grade-term">
        <label>年级 · 学期
          <select><option>五年级下</option></select>
        </label>
      </div>
    `)

    await expect(page.locator('.k12pf__row--grade-term > .k12pf__field')).toHaveCount(2)
    await expect(page.locator('.k12pf__row--grade-term .hc-select')).toHaveCount(2)
  })

  test('RED control catches an unresponsive back action', async ({ page }) => {
    test.skip(
      process.env.HEX_K12_PROFILE_RED !== '1',
      'negative control only runs when explicitly proving the old footer is rejected',
    )
    await page.setContent(`
      <div class="k12pf">
        <div class="k12pf__foot">
          <button data-testid="k12pf-back">上一步</button>
          <button>先看示例</button>
          <button>创建</button>
        </div>
      </div>
    `)

    await page.getByTestId('k12pf-back').click()
    await expect(page.getByText('选择起点', { exact: true })).toBeVisible()
  })

  test.beforeEach(async ({ page }) => {
    await installK12ProfileMocks(page)
  })

  test('existing 五年级下 round-trips as 六年级下 while term stays selected', async ({
    page,
    browserName,
  }) => {
    let savedProfile: Record<string, unknown> | undefined
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (
        url.pathname.replace(/^\/_hexclaw/, '') === '/api/k12/profile' &&
        request.method() === 'PUT'
      ) {
        savedProfile = request.postDataJSON() as Record<string, unknown>
      }
    })

    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const card = page.locator('.hc-cxcard', { hasText: '小明的辅导助手' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: '编辑档案', exact: true }).click()

    const form = page.locator('.k12pf')
    const gradeTermRow = form.locator('.k12pf__row--grade-term')
    await expect(gradeTermRow.locator(':scope > .k12pf__field')).toHaveCount(2)
    await expect(gradeTermRow.locator('.hc-select')).toHaveCount(2)

    const grade = page.getByTestId('k12pf-grade').getByRole('combobox')
    const semester = page.getByTestId('k12pf-semester').getByRole('combobox')
    await expect(grade).toHaveAccessibleName('年级')
    await expect(semester).toHaveAccessibleName('学期')
    await expect(grade).toContainText('五年级')
    await expect(semester).toContainText('下学期')

    const geometry = await gradeTermRow.locator(':scope > .k12pf__field').evaluateAll((fields) =>
      fields.map((field) => {
        const rect = field.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width }
      }),
    )
    expect(geometry).toHaveLength(2)
    expect(Math.abs(geometry[0].y - geometry[1].y)).toBeLessThanOrEqual(1)
    expect(geometry[1].x).toBeGreaterThan(geometry[0].x + geometry[0].width)

    await grade.click()
    const gradeOptions = page.getByRole('listbox').getByRole('option')
    await expect(gradeOptions).toHaveText([
      '一年级',
      '二年级',
      '三年级',
      '四年级',
      '五年级',
      '六年级',
    ])
    await gradeOptions.getByText('六年级', { exact: true }).click()

    // 年级变化不应把既有“下学期”静默重置为默认“上学期”。
    await expect(semester).toContainText('下学期')
    await semester.click()
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['上学期', '下学期'])
    await page.getByRole('listbox').getByRole('option', { name: '下学期', exact: true }).click()
    await expect(page.getByRole('listbox')).toHaveCount(0)

    await page.screenshot({
      path: `${ARTIFACT_DIR}/bug-20260723-k12-profile-edit-grade-term-${browserName}.png`,
      fullPage: true,
    })

    await form.getByRole('button', { name: '保存', exact: true }).click()
    await expect(form).toHaveCount(0)
    expect(savedProfile).toMatchObject({
      agent: K12_AGENT,
      child_name: '小明',
      grade_term: '六年级下',
      textbook_edition: '人教版',
    })
  })

  test('create footer is exact and back reaches the generic 选择起点 terminal state', async ({
    page,
    browserName,
  }) => {
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: '模板库', exact: true }).click()
    await page
      .locator('.hc-tplcard', { hasText: '作业辅导助手' })
      .getByText('作业辅导助手', { exact: true })
      .click()

    const form = page.locator('.k12pf')
    await expect(form).toBeVisible()
    await expect(form.getByTestId('k12pf-grade')).toBeVisible()
    await expect(form.getByTestId('k12pf-semester')).toBeVisible()
    await expect(form.locator('.k12pf__foot .k12pf__btn')).toHaveText(['上一步', '创建'])
    await expect(form.getByText('先看示例', { exact: true })).toHaveCount(0)
    await expect(form.getByTestId('k12pf-preview')).toHaveCount(0)

    await page.screenshot({
      path: `${ARTIFACT_DIR}/bug-20260723-k12-profile-create-grade-term-footer-${browserName}.png`,
      fullPage: true,
    })

    await form.getByTestId('k12pf-back').click()
    await expect(form).toHaveCount(0)
    await expect(page.getByText('选择起点', { exact: true })).toBeVisible()
    await expect(page.getByTestId('start-blank')).toBeVisible()
    await expect(page.getByTestId('start-from-library')).toBeVisible()

    await page.screenshot({
      path: `${ARTIFACT_DIR}/bug-20260723-k12-profile-back-to-start-${browserName}.png`,
      fullPage: true,
    })
  })
})
