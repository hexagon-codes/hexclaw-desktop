import { expect, test } from '@playwright/test'

function onePagePdf(): number[] {
  const pageContent = [
    '0.12 0.42 0.78 rg',
    '72 650 451 100 re f',
    '0.88 0.94 1 rg',
    '72 560 330 56 re f',
    '0 0 0 rg',
    '72 520 451 2 re f',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${new TextEncoder().encode(pageContent).length} >>\nstream\n${pageContent}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(pdf).length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = new TextEncoder().encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return Array.from(new TextEncoder().encode(pdf))
}

test('WKWebView-family preview renders the exact PDF Blob to canvas before enabling print', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const initiallyDisabled = await page.evaluate(async (bytes) => {
    const load = (specifier: string) =>
      (
        new Function('specifier', 'return import(specifier)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>
      )(specifier)
    const vue = await load('/@id/vue')
    const previewModule = await load('/src/features/k12/components/K12PrintPreviewModal.vue')
    const { createApp, defineComponent, h, ref } = vue as {
      createApp: (root: unknown) => { mount: (element: Element) => void }
      defineComponent: (options: unknown) => unknown
      h: (component: unknown, props: Record<string, unknown>) => unknown
      ref: <T>(value: T) => { value: T }
    }
    const Preview = previewModule.default
    const host = document.createElement('div')
    host.id = 'print-preview-browser-harness'
    document.body.append(host)
    const Harness = defineComponent({
      setup() {
        const open = ref(true)
        const pdf = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
        return () =>
          h(Preview, {
            open: open.value,
            title: '综合复习卷 · WebKit 预览',
            pdf,
            onClose: () => {
              open.value = false
            },
          })
      },
    })
    createApp(Harness).mount(host)
    return (
      document.querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')
        ?.disabled === true
    )
  }, onePagePdf())

  const dialog = page.getByTestId('k12-print-preview')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('iframe')).toHaveCount(0)
  expect(initiallyDisabled).toBe(true)

  await expect(page.getByTestId('k12-print-preview-ready')).toBeAttached({
    timeout: 30_000,
  })
  await expect(page.getByTestId('k12-print-preview-page')).toHaveCount(1)
  await expect(page.getByTestId('k12-print-preview-page').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('k12-print-preview-print')).toBeEnabled()

  const canvas = page.getByTestId('k12-print-preview-page').locator('canvas')
  const box = await canvas.boundingBox()
  expect(box?.width).toBeGreaterThan(500)
  expect(box?.height).toBeGreaterThan(700)
  const nonWhiteSampleCount = await canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext('2d')
    if (!context) return 0
    const { width, height } = node as HTMLCanvasElement
    const pixels = context.getImageData(0, 0, width, height).data
    let count = 0
    for (let index = 0; index < pixels.length; index += 64) {
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) {
        count += 1
      }
    }
    return count
  })
  expect(nonWhiteSampleCount).toBeGreaterThan(100)

  await dialog.screenshot({
    path: testInfo.outputPath(
      `bug-20260723-014-pdfjs-preview-${process.env.HEXCLAW_E2E_BROWSER === 'chromium' ? 'chromium' : 'webkit'}.png`,
    ),
  })
})
