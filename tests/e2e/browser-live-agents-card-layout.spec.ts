import { expect, test, type Page, type Route } from '@playwright/test'

const K12_AGENT = 'k12-tutor-layout'
const TRANSLATOR_AGENT = 'translator-layout'
const EMPTY_AGENT = 'empty-layout'

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockAgentsPage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  })

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')

    if (path === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: {},
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (path === '/api/v1/agents/rules') {
      return json(route, {
        rules: [
          {
            id: 1,
            platform: 'dingtalk',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: K12_AGENT,
            priority: 0,
          },
          {
            id: 2,
            platform: 'slack',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: TRANSLATOR_AGENT,
            priority: 0,
          },
        ],
        total: 2,
      })
    }
    if (path === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: K12_AGENT,
            display_name: '小明的辅导助手 · 五年级',
            description: '五年级下 · 各学科教材独立绑定 · 按年级边界讲解',
            model: '',
            provider: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级下',
            },
          },
          {
            name: TRANSLATOR_AGENT,
            display_name: '翻译官',
            description: '多语种互译 · 信达雅',
            model: '',
            provider: '',
          },
          {
            name: EMPTY_AGENT,
            display_name: '这是一个用于验证超长名称单行省略且不会挤压状态徽标的智能体',
            description: '这是一个同样很长的说明，用来验证描述只在自己的弹性区域内省略',
            model: '',
            provider: '',
          },
        ],
        total: 3,
        default: K12_AGENT,
      })
    }
    if (path === '/api/k12/mistakes') return json(route, { items: [{}, {}] })
    if (path === '/api/k12/review-queue') return json(route, { items: [{}] })

    return json(route, {})
  })
}

test.describe('专属智能体卡片三槽布局', () => {
  test('桌面等高、K12 不泄露通道，窄屏单列且不溢出', async ({ page }, testInfo) => {
    await mockAgentsPage(page)
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })

    const cards = page.locator('.hc-cxcard--dedicated')
    await expect(cards).toHaveCount(3)

    const k12Card = cards.filter({ hasText: '小明的辅导助手' })
    const translatorCard = cards.filter({ hasText: '翻译官' })
    await expect(k12Card).not.toContainText('dingtalk')
    await expect(translatorCard).toContainText('slack')
    await expect(cards.nth(2).locator('.hc-agent-card__facts')).toBeEmpty()

    const desktop = await page.evaluate(() => {
      const grid = document.querySelector('.hc-cxcards') as HTMLElement
      const cards = Array.from(
        document.querySelectorAll('.hc-cxcard--dedicated'),
      ) as HTMLElement[]
      const boxes = cards.map((card) => card.getBoundingClientRect())
      const footers = cards.map((card) =>
        (card.querySelector('.hc-agent-card__footer') as HTMLElement).getBoundingClientRect(),
      )
      const title = cards[2].querySelector('.hc-cxnm__label') as HTMLElement
      const description = cards[2].querySelector('.hc-cxmeta--card') as HTMLElement
      const badge = cards[0].querySelector('.hc-cxnm__badge') as HTMLElement
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        alignItems: getComputedStyle(grid).alignItems,
        boxes: boxes.map(({ x, y, width, height }) => ({ x, y, width, height })),
        footerY: footers.map(({ y }) => y),
        title: {
          overflow: getComputedStyle(title).overflow,
          textOverflow: getComputedStyle(title).textOverflow,
          whiteSpace: getComputedStyle(title).whiteSpace,
        },
        description: {
          overflow: getComputedStyle(description).overflow,
          textOverflow: getComputedStyle(description).textOverflow,
          whiteSpace: getComputedStyle(description).whiteSpace,
        },
        badgeFlexShrink: getComputedStyle(badge).flexShrink,
      }
    })

    expect(desktop.columns).toBe(2)
    expect(desktop.alignItems).toBe('stretch')
    expect(desktop.boxes.every((box) => box.height >= 146)).toBe(true)
    expect(Math.abs(desktop.boxes[0].y - desktop.boxes[1].y)).toBeLessThanOrEqual(1)
    expect(Math.abs(desktop.boxes[0].height - desktop.boxes[1].height)).toBeLessThanOrEqual(1)
    expect(Math.abs(desktop.footerY[0] - desktop.footerY[1])).toBeLessThanOrEqual(1)
    expect(desktop.title).toEqual({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    expect(desktop.description).toEqual({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    expect(desktop.badgeFlexShrink).toBe('0')

    await page.screenshot({
      path: testInfo.outputPath('agents-card-layout-desktop.png'),
      fullPage: true,
    })

    await page.setViewportSize({ width: 900, height: 820 })
    const narrow = await page.evaluate(() => {
      const grid = document.querySelector('.hc-cxcards') as HTMLElement
      const cards = Array.from(
        document.querySelectorAll('.hc-cxcard--dedicated'),
      ) as HTMLElement[]
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        gridOverflow: grid.scrollWidth - grid.clientWidth,
        cardOverflows: cards.map((card) => card.scrollWidth - card.clientWidth),
      }
    })
    expect(narrow.columns).toBe(1)
    expect(narrow.gridOverflow).toBeLessThanOrEqual(1)
    expect(narrow.cardOverflows.every((overflow) => overflow <= 1)).toBe(true)

    await page.screenshot({
      path: testInfo.outputPath('agents-card-layout-narrow.png'),
      fullPage: true,
    })
  })
})
