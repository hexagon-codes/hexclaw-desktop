import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const evidenceDir = path.resolve(
  process.cwd(),
  '../hexclaw-docs/test/evidence/bug-20260808-welcome-provider',
)

test.use({ viewport: { width: 440, height: 723 }, deviceScaleFactor: 2 })

async function mockWelcomeBackend(page: Page) {
  await page.route('**/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await page.route('**/api/v1/config/llm**', async (route) => {
    const request = route.request()
    if (request.url().endsWith('/api/v1/config/llm/test')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, message: '连接测试通过' }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.9, ttl: '1h', max_entries: 1000 },
      }),
    })
  })
}

async function writeAmplifiedPixelDiff(
  page: Page,
  referencePath: string,
  implementationPath: string,
  diffPath: string,
  metricsPath: string,
) {
  const [reference, implementation] = await Promise.all([
    readFile(referencePath),
    readFile(implementationPath),
  ])
  const diffPage = await page.context().newPage()
  const diffMetrics = await diffPage.evaluate(
    async ({ referenceUrl, implementationUrl }) => {
      const load = (url: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = url
        })
      const [referenceImage, implementationImage] = await Promise.all([
        load(referenceUrl),
        load(implementationUrl),
      ])
      if (
        referenceImage.naturalWidth !== implementationImage.naturalWidth ||
        referenceImage.naturalHeight !== implementationImage.naturalHeight
      ) {
        throw new Error('reference and implementation dimensions differ')
      }

      document.body.style.margin = '0'
      const canvas = document.createElement('canvas')
      canvas.width = referenceImage.naturalWidth
      canvas.height = referenceImage.naturalHeight
      canvas.style.width = `${canvas.width / devicePixelRatio}px`
      canvas.style.height = `${canvas.height / devicePixelRatio}px`
      document.body.append(canvas)

      const sample = document.createElement('canvas')
      sample.width = canvas.width
      sample.height = canvas.height
      const sampleContext = sample.getContext('2d', { willReadFrequently: true })
      const diffContext = canvas.getContext('2d')
      if (!sampleContext || !diffContext) throw new Error('2d canvas unavailable')

      sampleContext.drawImage(referenceImage, 0, 0)
      const referencePixels = sampleContext.getImageData(0, 0, canvas.width, canvas.height)
      sampleContext.clearRect(0, 0, canvas.width, canvas.height)
      sampleContext.drawImage(implementationImage, 0, 0)
      const implementationPixels = sampleContext.getImageData(0, 0, canvas.width, canvas.height)
      const output = diffContext.createImageData(canvas.width, canvas.height)
      let changedPixels = 0
      for (let index = 0; index < output.data.length; index += 4) {
        const delta = Math.max(
          Math.abs(referencePixels.data[index]! - implementationPixels.data[index]!),
          Math.abs(referencePixels.data[index + 1]! - implementationPixels.data[index + 1]!),
          Math.abs(referencePixels.data[index + 2]! - implementationPixels.data[index + 2]!),
          Math.abs(referencePixels.data[index + 3]! - implementationPixels.data[index + 3]!),
        )
        if (delta > 0) changedPixels += 1
        const amplified = Math.min(255, delta * 4)
        output.data[index] = 255
        output.data[index + 1] = 255 - amplified
        output.data[index + 2] = 255 - amplified
        output.data[index + 3] = 255
      }
      diffContext.putImageData(output, 0, 0)
      return {
        width: canvas.width,
        height: canvas.height,
        changedPixels,
        totalPixels: canvas.width * canvas.height,
      }
    },
    {
      referenceUrl: `data:image/png;base64,${reference.toString('base64')}`,
      implementationUrl: `data:image/png;base64,${implementation.toString('base64')}`,
    },
  )
  await writeFile(metricsPath, `${JSON.stringify(diffMetrics, null, 2)}\n`)
  await diffPage.locator('canvas').screenshot({ path: diffPath })
  await diffPage.close()
}

test('BUG-20260808 welcome uses current OpenAI models and one-row connection receipt', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await mkdir(evidenceDir, { recursive: true })
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
  })
  await mockWelcomeBackend(page)

  await page.goto('/welcome', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: '欢迎使用 HexClaw 河蟹 AI' })).toBeVisible()
  await expect(page.locator('#splash-screen')).toBeHidden({ timeout: 15_000 })

  await page.setViewportSize({ width: 451, height: 533 })
  const modelSelect = page.locator('.hc-select__trigger')
  await expect(modelSelect).toContainText('GPT-5.6 Sol')
  await modelSelect.click()
  const modelOptions = page.locator('.hc-select__dropdown [role="option"]')
  await expect(modelOptions).toHaveText(['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'])
  await page.screenshot({
    path: path.join(evidenceDir, 'implementation-openai-models-902x1066.png'),
  })
  await writeAmplifiedPixelDiff(
    page,
    path.join(evidenceDir, 'reference-openai-models-902x1066.png'),
    path.join(evidenceDir, 'implementation-openai-models-902x1066.png'),
    path.join(evidenceDir, 'pixel-diff-openai-models-amplified-902x1066.png'),
    path.join(evidenceDir, 'visual-diff-openai-models-metrics.json'),
  )
  await page.keyboard.press('Escape')

  const correctedProviderModels = [
    {
      provider: 'Kimi (月之暗面)',
      models: ['Kimi K3', 'Kimi K2.7 Code', 'Kimi K2.7 Code Highspeed', 'Kimi K2.6'],
    },
    {
      provider: '文心一言 (百度)',
      models: ['ERNIE 5.1', 'ERNIE 5.0', 'ERNIE X1.1 Preview'],
    },
    { provider: '腾讯混元', models: ['Tencent HY 3'] },
  ]

  for (const candidate of correctedProviderModels) {
    await page.locator('.hc-provider-select__trigger').click()
    await page.getByRole('option', { name: candidate.provider, exact: true }).click()
    await modelSelect.click()
    await expect(page.locator('.hc-select__dropdown [role="option"]')).toHaveText(candidate.models)
    await page.keyboard.press('Escape')
  }

  await page.setViewportSize({ width: 440, height: 723 })
  await page.locator('.hc-provider-select__trigger').click()
  await page.getByRole('option', { name: '自定义' }).click()
  await page.locator('input[type="password"]').fill('visual-test-key')
  await page.locator('input[type="text"]').nth(0).fill('http://127.0.0.1:18080/v1')
  await page.locator('input[type="text"]').nth(1).fill('gpt-5.6-sol')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByTestId('welcome-connection-receipt')).toHaveText('连接测试通过')

  const geometry = await page.evaluate(() => {
    const inspect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) throw new Error(`missing ${selector}`)
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        box: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          right: box.right,
          bottom: box.bottom,
        },
        style: {
          display: style.display,
          flexDirection: style.flexDirection,
          alignItems: style.alignItems,
          gap: style.gap,
          whiteSpace: style.whiteSpace,
        },
      }
    }

    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      row: inspect('[data-testid="welcome-connection-actions"]'),
      button: inspect('[data-testid="welcome-connection-actions"] button'),
      receipt: inspect('[data-testid="welcome-connection-receipt"]'),
    }
  })

  expect(Math.abs(geometry.button.box.y - geometry.receipt.box.y)).toBeLessThanOrEqual(1)
  expect(geometry.button.box.right).toBeLessThan(geometry.receipt.box.x)
  expect(geometry.row.style.display).toBe('flex')
  expect(geometry.row.style.alignItems).toBe('center')

  await writeFile(
    path.join(evidenceDir, 'implementation-geometry.json'),
    `${JSON.stringify(geometry, null, 2)}\n`,
  )
  await page.screenshot({
    path: path.join(evidenceDir, 'implementation-connection-row-880x1446.png'),
  })

  await writeAmplifiedPixelDiff(
    page,
    path.join(evidenceDir, 'reference-before-880x1446.png'),
    path.join(evidenceDir, 'implementation-connection-row-880x1446.png'),
    path.join(evidenceDir, 'pixel-diff-amplified-880x1446.png'),
    path.join(evidenceDir, 'visual-diff-metrics.json'),
  )
})
