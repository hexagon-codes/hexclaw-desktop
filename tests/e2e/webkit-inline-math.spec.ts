import { expect, test } from '@playwright/test'
import { renderKatexToHtml } from '../../src/utils/math-render'

const ADJACENT_FORMULAS = [
  String.raw`3\frac{1}{4} = \frac{3 \times 4 + 1}{4} = \frac{13}{4}`,
  String.raw`2\frac{1}{3} = \frac{2 \times 3 + 1}{3} = \frac{7}{3}`,
] as const

const LONG_FORMULA = String.raw`\frac{123456789}{987654321} + \frac{234567891}{876543219} + \frac{345678912}{765432198} + \frac{456789123}{654321987} = \frac{1111111110}{328395061}`

const DEEP_FORMULA = String.raw`\frac{1+\frac{2+\frac{3}{4}}{5}}{\sqrt{6+\frac{7}{8}}}+\sum_{i=1}^{n^2}\frac{i^3}{(i+1)^2}`

const SURFACES = ['user', 'assistant'] as const
const DIRECTIONS = ['ltr', 'rtl'] as const

test.describe('shared WebKit math shell/viewport geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch {
        // Ignore storage restrictions in browser fixtures.
      }
    })
    await page.goto('/chat')
    await page.waitForFunction(() => {
      const probe = document.createElement('span')
      probe.className = 'hc-math-inline'
      document.body.appendChild(probe)
      const ready = getComputedStyle(probe).display === 'inline-block'
      probe.remove()
      return ready
    })
  })

  test('keeps ordinary, overflowing, long, deep, and RTL fraction ink visible', async ({
    page,
  }) => {
    const ordinaryHtml = ADJACENT_FORMULAS.map((formula, index) => ({
      index,
      viewport: renderKatexToHtml(formula, false),
    }))
    const forcedHtml = renderKatexToHtml(ADJACENT_FORMULAS[0], false)
    const longHtml = renderKatexToHtml(LONG_FORMULA, false)
    const deepHtml = renderKatexToHtml(DEEP_FORMULA, true)

    const results = await page.evaluate(
      async ({ adjacent, forced, long, deep, surfaces, directions }) => {
        await document.fonts.ready

        const stage = document.createElement('div')
        stage.style.cssText = [
          'position:fixed',
          'inset:0 auto auto 0',
          'width:900px',
          'height:900px',
          'overflow:hidden',
          'pointer-events:none',
          'z-index:2147483647',
        ].join(';')
        document.body.appendChild(stage)

        function syncMathViewports(root: ParentNode) {
          const viewports = Array.from(root.querySelectorAll<HTMLElement>('.hc-math-viewport'))
          for (const viewport of viewports) {
            viewport.classList.remove('hc-math-viewport--scrollable')
            viewport.removeAttribute('tabindex')
            const needsHorizontalViewport =
              viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth + 1
            viewport.dataset.needsHorizontalViewport = String(needsHorizontalViewport)
            if (needsHorizontalViewport) {
              viewport.classList.add('hc-math-viewport--scrollable')
              viewport.tabIndex = 0
            }
          }
        }

        function fractionInk(viewport: HTMLElement) {
          return Array.from(viewport.querySelectorAll<HTMLElement>('.mfrac')).map(
            (fraction, fractionIndex) => {
              const line = Array.from(fraction.querySelectorAll<HTMLElement>('.frac-line')).find(
                (candidate) => candidate.closest('.mfrac') === fraction,
              )
              if (!line) {
                throw new Error(`fraction ${fractionIndex} has no owned fraction line`)
              }

              const lineRect = line.getBoundingClientRect()
              const lineCenter = (lineRect.top + lineRect.bottom) / 2
              const leaves = Array.from(fraction.querySelectorAll<HTMLElement>('span'))
                .filter((candidate) => {
                  if (candidate.children.length > 0 || !candidate.textContent?.trim()) return false
                  const rect = candidate.getBoundingClientRect()
                  return rect.width > 0.1 && rect.height > 0.1
                })
                .map((candidate) => {
                  const rect = candidate.getBoundingClientRect()
                  return {
                    top: rect.top,
                    bottom: rect.bottom,
                    center: (rect.top + rect.bottom) / 2,
                  }
                })
              const numeratorLeaves = leaves.filter((leaf) => leaf.center < lineCenter - 0.1)
              const denominatorLeaves = leaves.filter((leaf) => leaf.center > lineCenter + 0.1)
              if (numeratorLeaves.length === 0 || denominatorLeaves.length === 0) {
                throw new Error(
                  `fraction ${fractionIndex} does not expose numerator and denominator leaves`,
                )
              }

              return {
                numeratorTop: Math.min(...numeratorLeaves.map((leaf) => leaf.top)),
                numeratorBottom: Math.max(...numeratorLeaves.map((leaf) => leaf.bottom)),
                lineTop: lineRect.top,
                lineBottom: lineRect.bottom,
                lineWidth: lineRect.width,
                denominatorTop: Math.min(...denominatorLeaves.map((leaf) => leaf.top)),
                denominatorBottom: Math.max(...denominatorLeaves.map((leaf) => leaf.bottom)),
              }
            },
          )
        }

        function inspectHost(
          kind: 'ordinary' | 'forced' | 'long' | 'deep',
          surface: (typeof surfaces)[number],
          direction: (typeof directions)[number],
          width: number,
          markup: string,
        ) {
          const host = document.createElement('div')
          host.dir = direction
          host.lang = direction === 'rtl' ? 'ug-CN' : 'zh-CN'
          host.className = surface === 'user' ? 'hc-msg__text' : 'markdown-body'
          host.style.cssText = [
            'position:absolute',
            'left:20px',
            'top:20px',
            `width:${width}px`,
            'font-size:14px',
            'line-height:1.7',
            'white-space:pre-wrap',
            'word-break:break-word',
          ].join(';')
          host.innerHTML = markup
          stage.appendChild(host)
          syncMathViewports(host)

          const hostRect = host.getBoundingClientRect()
          const viewports = Array.from(host.querySelectorAll<HTMLElement>('.hc-math-viewport')).map(
            (viewport) => {
              const shell = viewport.parentElement!
              const viewportRect = viewport.getBoundingClientRect()
              const shellRect = shell.getBoundingClientRect()
              const viewportStyle = getComputedStyle(viewport)
              const shellStyle = getComputedStyle(shell)
              const katex = viewport.firstElementChild as HTMLElement | null
              const expectedKatexClass = viewport.classList.contains('hc-math-viewport--display')
                ? 'katex-display'
                : 'katex'
              const fractions = fractionInk(viewport)
              viewport.scrollLeft = viewport.scrollWidth

              return {
                annotation:
                  viewport.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
                  '',
                directViewport: shell.firstElementChild === viewport,
                directKatex:
                  viewport.children.length === 1 && !!katex?.classList.contains(expectedKatexClass),
                inlineViewport: viewport.classList.contains('hc-math-viewport--inline'),
                displayViewport: viewport.classList.contains('hc-math-viewport--display'),
                neededHorizontalViewport: viewport.dataset.needsHorizontalViewport === 'true',
                scrollable: viewport.classList.contains('hc-math-viewport--scrollable'),
                tabIndex: viewport.tabIndex,
                shellDisplay: shellStyle.display,
                shellOverflowX: shellStyle.overflowX,
                shellOverflowY: shellStyle.overflowY,
                viewportOverflowX: viewportStyle.overflowX,
                viewportOverflowY: viewportStyle.overflowY,
                viewportDirection: viewportStyle.direction,
                katexDirection: katex ? getComputedStyle(katex).direction : '',
                katexUnicodeBidi: katex ? getComputedStyle(katex).unicodeBidi : '',
                paddingTop: Number.parseFloat(viewportStyle.paddingTop),
                paddingBottom: Number.parseFloat(viewportStyle.paddingBottom),
                shellLeft: shellRect.left,
                shellRight: shellRect.right,
                viewportTop: viewportRect.top,
                viewportBottom: viewportRect.bottom,
                clientWidth: viewport.clientWidth,
                scrollWidth: viewport.scrollWidth,
                scrollLeft: viewport.scrollLeft,
                fractions,
              }
            },
          )

          const result = {
            kind,
            surface,
            direction,
            width,
            hostDirection: getComputedStyle(host).direction,
            hostLeft: hostRect.left,
            hostRight: hostRect.right,
            hostScrollLeak: host.scrollWidth - host.clientWidth,
            pageScrollLeak:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
            beforeText: host.querySelector('[data-boundary="before"]')?.textContent ?? '',
            afterText: host.querySelector('[data-boundary="after"]')?.textContent ?? '',
            equationsAreAdjacent:
              host.querySelector('[data-equation="0"]')?.nextElementSibling ===
              host.querySelector('[data-equation="1"]'),
            viewports,
          }
          host.remove()
          return result
        }

        const measurements = surfaces.flatMap((surface) =>
          directions.flatMap((direction) => {
            const ordinaryEquations = adjacent
              .map(
                ({ viewport, index }) =>
                  `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline" data-math-shell data-equation="${index}">${viewport}</span>`,
              )
              .join('')
            const ordinaryContent = `<span data-boundary="before">前文：</span>${ordinaryEquations}<span data-boundary="after">：后文</span>`
            const ordinaryMarkup =
              surface === 'user' ? ordinaryContent : `<p>${ordinaryContent}</p>`

            const forcedEquation = `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline" data-math-shell>${forced}</span>`
            const forcedMarkup =
              surface === 'user'
                ? `<span>前文：</span>${forcedEquation}<span>：后文</span>`
                : `<p><span>前文：</span>${forcedEquation}<span>：后文</span></p>`

            const longEquation = `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline" data-math-shell>${long}</span>`
            const longMarkup =
              surface === 'user'
                ? `<span>前文：</span>${longEquation}<span>：后文</span>`
                : `<p><span>前文：</span>${longEquation}<span>：后文</span></p>`

            const deepMarkup =
              surface === 'user'
                ? `<span class="hc-msg__math hc-msg__math--display" data-math-shell>${deep}</span>`
                : `<p class="katex-block" data-math-shell>${deep}</p>`

            return [
              inspectHost('ordinary', surface, direction, 320, ordinaryMarkup),
              inspectHost('forced', surface, direction, 75, forcedMarkup),
              inspectHost('long', surface, direction, 140, longMarkup),
              inspectHost('deep', surface, direction, 140, deepMarkup),
            ]
          }),
        )
        stage.remove()
        return measurements
      },
      {
        adjacent: ordinaryHtml,
        forced: forcedHtml,
        long: longHtml,
        deep: deepHtml,
        surfaces: SURFACES,
        directions: DIRECTIONS,
      },
    )

    expect(results).toHaveLength(SURFACES.length * DIRECTIONS.length * 4)

    for (const result of results) {
      const fixtureLabel = `${result.kind} ${result.surface} ${result.direction}@${result.width}`
      expect(result.hostDirection, fixtureLabel).toBe(result.direction)
      expect(result.hostScrollLeak, fixtureLabel).toBeLessThanOrEqual(1)
      expect(result.pageScrollLeak, fixtureLabel).toBeLessThanOrEqual(1)
      expect(result.viewports.length, fixtureLabel).toBeGreaterThan(0)

      if (result.kind === 'ordinary') {
        expect(result.beforeText, fixtureLabel).toBe('前文：')
        expect(result.afterText, fixtureLabel).toBe('：后文')
        expect(result.equationsAreAdjacent, fixtureLabel).toBe(true)
        expect(result.viewports).toHaveLength(ADJACENT_FORMULAS.length)
      }

      result.viewports.forEach((viewport, viewportIndex) => {
        const label = `${fixtureLabel} viewport ${viewportIndex + 1}`
        expect(viewport.directViewport, label).toBe(true)
        expect(viewport.directKatex, label).toBe(true)
        expect(viewport.viewportDirection, label).toBe('ltr')
        expect(viewport.katexDirection, label).toBe('ltr')
        if (result.direction === 'rtl') {
          expect(viewport.katexUnicodeBidi, label).toBe('isolate')
        }
        expect(viewport.shellOverflowX, label).toBe('visible')
        expect(viewport.shellOverflowY, label).toBe('visible')
        expect(viewport.scrollable, label).toBe(viewport.neededHorizontalViewport)
        expect(viewport.shellLeft, label).toBeGreaterThanOrEqual(result.hostLeft - 1)
        expect(viewport.shellRight, label).toBeLessThanOrEqual(result.hostRight + 1)
        expect(viewport.fractions.length, label).toBeGreaterThan(0)

        if (result.kind === 'deep') {
          expect(viewport.displayViewport, label).toBe(true)
          expect(viewport.inlineViewport, label).toBe(false)
        } else {
          expect(viewport.inlineViewport, label).toBe(true)
          expect(viewport.displayViewport, label).toBe(false)
        }

        if (result.kind === 'ordinary') {
          expect(viewport.neededHorizontalViewport, label).toBe(false)
          expect(viewport.viewportOverflowX, label).toBe('visible')
          expect(viewport.viewportOverflowY, label).toBe('visible')
          expect(viewport.tabIndex, label).toBe(-1)
          expect(viewport.paddingTop, label).toBe(0)
          expect(viewport.paddingBottom, label).toBe(0)
        } else {
          expect(viewport.neededHorizontalViewport, label).toBe(true)
          expect(viewport.viewportOverflowX, label).toBe('auto')
          expect(viewport.viewportOverflowY, label).toBe('hidden')
          expect(viewport.tabIndex, label).toBe(0)
          expect(viewport.scrollWidth, label).toBeGreaterThan(viewport.clientWidth + 1)
          expect(viewport.scrollLeft, label).toBeGreaterThan(0)
          expect(viewport.paddingTop, label).toBeGreaterThan(0)
          expect(viewport.paddingBottom, label).toBeGreaterThan(0)
        }

        viewport.fractions.forEach((fraction, fractionIndex) => {
          const fractionLabel = `${label} fraction ${fractionIndex + 1}`
          expect(fraction.lineWidth, fractionLabel).toBeGreaterThan(0)
          expect(fraction.numeratorTop, fractionLabel).toBeLessThan(fraction.lineTop)
          expect(fraction.denominatorBottom, fractionLabel).toBeGreaterThan(fraction.lineBottom)

          if (viewport.scrollable) {
            expect(fraction.numeratorTop, fractionLabel).toBeGreaterThanOrEqual(
              viewport.viewportTop - 1,
            )
            expect(fraction.lineTop, fractionLabel).toBeGreaterThanOrEqual(viewport.viewportTop - 1)
            expect(fraction.lineBottom, fractionLabel).toBeLessThanOrEqual(
              viewport.viewportBottom + 1,
            )
            expect(fraction.denominatorBottom, fractionLabel).toBeLessThanOrEqual(
              viewport.viewportBottom + 1,
            )
          }
        })
      })
    }

    const ordinary = results.filter((result) => result.kind === 'ordinary')
    const forced = results.filter((result) => result.kind === 'forced')
    const long = results.filter((result) => result.kind === 'long')
    const deep = results.filter((result) => result.kind === 'deep')
    expect(ordinary).toHaveLength(SURFACES.length * DIRECTIONS.length)
    expect(forced).toHaveLength(SURFACES.length * DIRECTIONS.length)
    expect(long).toHaveLength(SURFACES.length * DIRECTIONS.length)
    expect(deep).toHaveLength(SURFACES.length * DIRECTIONS.length)
    expect(results.some((result) => result.direction === 'rtl')).toBe(true)
  })
})
