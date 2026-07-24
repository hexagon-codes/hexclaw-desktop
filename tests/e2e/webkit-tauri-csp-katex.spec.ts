import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { renderKatexToHtml } from '../../src/utils/math-render'

const KATEX_DIST = path.resolve(process.cwd(), 'node_modules/katex/dist')

test('Tauri-style CSP keeps KaTeX inline layout declarations active', async ({
  context,
  page,
}) => {
  await context.route('**/__tauri-katex.css', async (route) => {
    await route.fulfill({
      contentType: 'text/css',
      body: await readFile(path.join(KATEX_DIST, 'katex.min.css')),
    })
  })
  await context.route('**/fonts/KaTeX_*', async (route) => {
    const fileName = path.basename(new URL(route.request().url()).pathname)
    const extension = path.extname(fileName)
    expect(['.woff2', '.woff', '.ttf']).toContain(extension)
    await route.fulfill({
      contentType:
        extension === '.woff2'
          ? 'font/woff2'
          : extension === '.woff'
            ? 'font/woff'
            : 'font/ttf',
      body: await readFile(path.join(KATEX_DIST, 'fonts', fileName)),
    })
  })
  await context.route('**/__tauri-csp-katex', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      headers: {
        // Tauri v2 appends hashes/nonces to style-src for bundled assets.
        // Once a hash is present, style-src 'unsafe-inline' no longer covers
        // style="" attributes. The dedicated CSP3 directive is the fix.
        'content-security-policy': [
          "default-src 'self'",
          "style-src 'self' 'unsafe-inline' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='",
          "style-src-attr 'unsafe-inline'",
          "font-src 'self'",
          "script-src 'none'",
          "object-src 'none'",
        ].join('; '),
      },
      body: [
        '<!doctype html>',
        '<html><head>',
        '<meta charset="UTF-8">',
        '<link rel="stylesheet" href="/__tauri-katex.css">',
        '</head><body><div id="probe"></div></body></html>',
      ].join(''),
    })
  })

  await page.goto('/__tauri-csp-katex')
  const result = await page.evaluate(async (markup) => {
    const probe = document.querySelector<HTMLElement>('#probe')!
    probe.innerHTML = markup
    await document.fonts.load('16px KaTeX_Main', '1')
    await document.fonts.ready

    const positionedLayers = Array.from(
      probe.querySelectorAll<HTMLElement>('.mfrac .vlist > span[style*="top"]'),
    )
    const fraction = probe.querySelector<HTMLElement>('.mfrac')!
    const vlist = fraction.querySelector<HTMLElement>(':scope > .vlist-t > .vlist-r > .vlist')!
    const layers = Array.from(vlist.children) as HTMLElement[]
    const line = probe.querySelector<HTMLElement>('.mfrac .frac-line')!
    const lineRect = line.getBoundingClientRect()
    const denominatorRect = layers[0]!.querySelector<HTMLElement>('.mord')!.getBoundingClientRect()
    const numeratorRect = layers[2]!.querySelector<HTMLElement>('.mord')!.getBoundingClientRect()

    return {
      fontLoaded: document.fonts.check('16px KaTeX_Main'),
      positionedLayers: positionedLayers.map((element) => ({
        attribute: element.getAttribute('style'),
        cssText: element.style.cssText,
        top: getComputedStyle(element).top,
      })),
      lineWidth: lineRect.width,
      numeratorCenter: (numeratorRect.top + numeratorRect.bottom) / 2,
      lineCenter: (lineRect.top + lineRect.bottom) / 2,
      denominatorCenter: (denominatorRect.top + denominatorRect.bottom) / 2,
    }
  }, renderKatexToHtml(String.raw`\frac{1}{2}`, false))

  expect(result.fontLoaded).toBe(true)
  expect(result.positionedLayers.length).toBeGreaterThanOrEqual(3)
  for (const layer of result.positionedLayers) {
    expect(layer.attribute).toContain('top:')
    expect(layer.cssText).toContain('top:')
    expect(layer.top).not.toBe('auto')
  }
  expect(result.lineWidth).toBeGreaterThan(0)
  expect(result.numeratorCenter).toBeLessThan(result.lineCenter)
  expect(result.denominatorCenter).toBeGreaterThan(result.lineCenter)
})
