import { expect, test, type Page } from '@playwright/test'

async function mockSettingsBackend(page: Page) {
  await page.route('http://localhost:11434/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ models: [], version: 'test' }),
  }))
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/_hexclaw/, '')
    const json = (body: unknown) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })

    if (path === '/api/v1/config/llm' && request.method() === 'GET') {
      return json({
        default: 'openai',
        providers: {
          openai: {
            api_key: '****test',
            base_url: 'http://localhost:18080/v1',
            model: 'gpt-5.6',
            models: ['gpt-5.6'],
            compatible: 'openai',
            locality: 'cloud',
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      })
    }
    if (path === '/api/v1/config/llm/test') {
      return json({ ok: true, message: '连接测试通过', provider: 'openai', model: 'gpt-5.6' })
    }
    if (path === '/api/v1/config/llm/models') {
      return json({ models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }] })
    }
    if (path === '/api/v1/config/llm' && request.method() === 'PUT') return json({ status: 'ok' })
    if (path === '/api/v1/llm/capabilities') return json({ models: {} })
    if (path === '/api/v1/config') {
      return json({
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        llm: { default: 'openai', providers: {} },
        knowledge: {}, mcp: {}, cron: {}, webhook: {}, canvas: {}, voice: {}, sandbox: {}, security: {},
      })
    }
    return json({})
  })
}

test('localhost provider probe and clear buttons close the Settings user journey', async ({ page }) => {
  await mockSettingsBackend(page)
  await page.goto('/settings')
  const providerHead = page.locator('.hc-provider__card-head').filter({ hasText: /openai/i }).last()
  const providerCard = providerHead.locator('..')
  await providerHead.click()
  await expect(providerCard.getByText('Base URL')).toBeVisible()

  const probeRequest = page.waitForRequest((request) =>
    request.url().includes('/api/v1/config/llm/test'),
  )
  await providerHead.getByTitle('测试连接', { exact: true }).click()
  const request = await probeRequest
  expect((await request.postDataJSON()).provider.base_url).toBe('http://localhost:18080/v1')
  await expect(providerCard.getByText('连接测试通过')).toBeVisible()

  const apiField = providerCard.locator('.hc-settings__field').filter({ hasText: 'API Key' })
  const apiClear = apiField.getByRole('button', { name: '清空输入内容' })
  const eye = apiField.locator('.hc-settings__eye-btn')
  await expect(apiClear).toBeVisible()
  await expect(eye).toBeVisible()
  const overlap = await apiField.evaluate((field) => {
    const clear = field.querySelector<HTMLElement>('.hc-clearable-field__button')!.getBoundingClientRect()
    const reveal = field.querySelector<HTMLElement>('.hc-settings__eye-btn')!.getBoundingClientRect()
    return !(
      clear.right <= reveal.left || reveal.right <= clear.left ||
      clear.bottom <= reveal.top || reveal.bottom <= clear.top
    )
  })
  expect(overlap).toBe(false)

  const baseField = providerCard.locator('.hc-settings__field').filter({ hasText: 'Base URL' })
  const baseInput = baseField.locator('input')
  await baseField.getByRole('button', { name: '清空输入内容' }).click()
  await expect(baseInput).toHaveValue('')
  await expect(baseInput).toBeFocused()
  await expect(baseField.getByRole('button', { name: '清空输入内容' })).toHaveCount(0)
})
