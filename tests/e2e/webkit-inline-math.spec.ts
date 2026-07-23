import { expect, test } from '@playwright/test'
import katex from 'katex'

const ADJACENT_FORMULAS = [
  String.raw`3\frac{1}{4} = \frac{3 \times 4 + 1}{4} = \frac{13}{4}`,
  String.raw`2\frac{1}{3} = \frac{2 \times 3 + 1}{3} = \frac{7}{3}`,
] as const

const LONG_FORMULA = String.raw`\frac{123456789}{987654321} + \frac{234567891}{876543219} + \frac{345678912}{765432198} + \frac{456789123}{654321987} = \frac{1111111110}{328395061}`

const WIDTHS = [75, 140, 320] as const
const SURFACES = ['user', 'assistant'] as const

function renderFormula(formula: string, displayMode = false): string {
  return katex.renderToString(formula, {
    displayMode,
    throwOnError: false,
  })
}

test.describe('shared inline-math geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch {
        // ignore storage restrictions
      }
    })
    await page.goto('/chat')
    await page.waitForSelector('.hc-chat__input-area', { timeout: 20_000 })
  })

  test('keeps two complete adjacent equations atomic in user and Markdown assistant DOMs at 75/140/320px', async ({
    page,
  }) => {
    const rendered = ADJACENT_FORMULAS.map(renderFormula)

    const results = await page.evaluate(
      ({ html, widths, surfaces }) => {
        const stage = document.createElement('div')
        stage.style.cssText =
          'position:fixed;inset:0 auto auto 0;width:900px;height:700px;overflow:hidden;pointer-events:none;z-index:2147483647'
        document.body.appendChild(stage)

        const measurements = surfaces.flatMap((surface, surfaceIndex) =>
          widths.map((width, widthIndex) => {
            const host = document.createElement('div')
            host.dataset.surface = surface
            host.dir = 'ltr'
            host.style.cssText = [
              'position:absolute',
              `left:${20 + surfaceIndex * 390}px`,
              `top:${20 + widthIndex * 150}px`,
              `width:${width}px`,
              'font-size:14px',
              'line-height:1.7',
              'white-space:pre-wrap',
              'word-break:break-word',
            ].join(';')

            const before = '<span data-boundary="before">前文：</span>'
            const equations = html
              .map(
                (formulaHtml, index) =>
                  `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline" data-equation="${index}">${formulaHtml}</span>`,
              )
              .join('')
            const after = '<span data-boundary="after">：后文</span>'
            host.className = surface === 'user' ? 'hc-msg__text' : 'markdown-body'
            host.innerHTML =
              surface === 'user'
                ? `${before}${equations}${after}`
                : `<p>${before}${equations}${after}</p>`
            stage.appendChild(host)

            const hostRect = host.getBoundingClientRect()
            const wrappers = Array.from(host.querySelectorAll<HTMLElement>('.hc-math-inline')).map(
              (wrapper) => {
                const rect = wrapper.getBoundingClientRect()
                const baseTops = Array.from(
                  wrapper.querySelectorAll<HTMLElement>('.katex-html > .base'),
                ).map((base) => base.getBoundingClientRect().top)
                const style = getComputedStyle(wrapper)
                const katexRect = wrapper
                  .querySelector<HTMLElement>('.katex')!
                  .getBoundingClientRect()
                return {
                  annotation:
                    wrapper.querySelector('annotation[encoding="application/x-tex"]')
                      ?.textContent ?? '',
                  baseCount: baseTops.length,
                  baseTopSpread:
                    baseTops.length > 0
                      ? Math.max(...baseTops) - Math.min(...baseTops)
                      : Number.NaN,
                  display: style.display,
                  whiteSpace: style.whiteSpace,
                  wordBreak: style.wordBreak,
                  verticalAlign: style.verticalAlign,
                  direction: style.direction,
                  unicodeBidi: style.unicodeBidi,
                  overflowX: style.overflowX,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  katexTop: katexRect.top,
                  katexBottom: katexRect.bottom,
                  width: rect.width,
                  clientWidth: wrapper.clientWidth,
                  scrollWidth: wrapper.scrollWidth,
                }
              },
            )
            const beforeNode = host.querySelector<HTMLElement>('[data-boundary="before"]')!
            const afterNode = host.querySelector<HTMLElement>('[data-boundary="after"]')!
            const firstEquation = host.querySelector<HTMLElement>('[data-equation="0"]')!
            const secondEquation = host.querySelector<HTMLElement>('[data-equation="1"]')!
            const result = {
              surface,
              width,
              hostLeft: hostRect.left,
              hostRight: hostRect.right,
              hostScrollLeak: host.scrollWidth - host.clientWidth,
              pageScrollLeak:
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              beforeText: beforeNode.textContent,
              afterText: afterNode.textContent,
              equationsAreAdjacent: firstEquation.nextElementSibling === secondEquation,
              boundariesInLogicalOrder:
                !!(
                  beforeNode.compareDocumentPosition(firstEquation) &
                  Node.DOCUMENT_POSITION_FOLLOWING
                ) &&
                !!(
                  secondEquation.compareDocumentPosition(afterNode) &
                  Node.DOCUMENT_POSITION_FOLLOWING
                ),
              wrappers,
            }
            host.remove()
            return result
          }),
        )
        stage.remove()
        return measurements
      },
      {
        html: rendered,
        widths: WIDTHS,
        surfaces: SURFACES,
      },
    )

    expect(results).toHaveLength(SURFACES.length * WIDTHS.length)
    for (const result of results) {
      expect(result.beforeText, `${result.surface}@${result.width}`).toBe('前文：')
      expect(result.afterText, `${result.surface}@${result.width}`).toBe('：后文')
      expect(result.equationsAreAdjacent, `${result.surface}@${result.width}`).toBe(true)
      expect(result.boundariesInLogicalOrder, `${result.surface}@${result.width}`).toBe(true)
      expect(result.hostScrollLeak, `${result.surface}@${result.width}`).toBeLessThanOrEqual(1)
      expect(result.pageScrollLeak, `${result.surface}@${result.width}`).toBeLessThanOrEqual(1)
      expect(result.wrappers).toHaveLength(ADJACENT_FORMULAS.length)

      result.wrappers.forEach((wrapper, index) => {
        const label = `${result.surface}@${result.width} equation ${index + 1}`
        expect(wrapper.annotation, label).toBe(ADJACENT_FORMULAS[index])
        expect(wrapper.baseCount, label).toBeGreaterThan(1)
        expect(wrapper.baseTopSpread, label).toBeLessThanOrEqual(1)
        expect(wrapper.display, label).toBe('inline-block')
        expect(wrapper.whiteSpace, label).toBe('nowrap')
        expect(wrapper.wordBreak, label).toBe('normal')
        expect(wrapper.verticalAlign, label).toBe('middle')
        expect(wrapper.direction, label).toBe('ltr')
        expect(wrapper.unicodeBidi, label).toBe('isolate')
        expect(wrapper.overflowX, label).toBe('auto')
        expect(wrapper.left, label).toBeGreaterThanOrEqual(result.hostLeft - 1)
        expect(wrapper.right, label).toBeLessThanOrEqual(result.hostRight + 1)
        expect(wrapper.width, label).toBeLessThanOrEqual(result.width + 1)
        expect(wrapper.katexTop, label).toBeGreaterThanOrEqual(wrapper.top - 1)
        expect(wrapper.katexBottom, label).toBeLessThanOrEqual(wrapper.bottom + 1)
      })
    }
  })

  test('preserves Chinese boundaries and LTR equation internals inside an RTL container', async ({
    page,
  }) => {
    const rendered = ADJACENT_FORMULAS.map(renderFormula)

    const results = await page.evaluate(
      ({ html, widths, surfaces }) =>
        surfaces.flatMap((surface) =>
          widths.map((width) => {
            const host = document.createElement('div')
            host.dir = 'rtl'
            host.lang = 'ug-CN'
            host.className = surface === 'user' ? 'hc-msg__text' : 'markdown-body'
            host.style.cssText = [
              'position:fixed',
              'left:20px',
              'top:20px',
              `width:${width}px`,
              'font-size:14px',
              'line-height:1.7',
              'white-space:pre-wrap',
              'word-break:break-word',
            ].join(';')
            const equations = html
              .map(
                (formulaHtml, index) =>
                  `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline" data-equation="${index}">${formulaHtml}</span>`,
              )
              .join('')
            const content = `<span data-boundary="before">前文：</span>${equations}<span data-boundary="after">：后文</span>`
            host.innerHTML = surface === 'user' ? content : `<p>${content}</p>`
            document.body.appendChild(host)

            const hostRect = host.getBoundingClientRect()
            const wrappers = Array.from(host.querySelectorAll<HTMLElement>('.hc-math-inline')).map(
              (wrapper) => {
                const rect = wrapper.getBoundingClientRect()
                const baseTops = Array.from(
                  wrapper.querySelectorAll<HTMLElement>('.katex-html > .base'),
                ).map((base) => base.getBoundingClientRect().top)
                const style = getComputedStyle(wrapper)
                const katexRect = wrapper
                  .querySelector<HTMLElement>('.katex')!
                  .getBoundingClientRect()
                return {
                  annotation:
                    wrapper.querySelector('annotation[encoding="application/x-tex"]')
                      ?.textContent ?? '',
                  baseTopSpread:
                    baseTops.length > 0
                      ? Math.max(...baseTops) - Math.min(...baseTops)
                      : Number.NaN,
                  direction: style.direction,
                  unicodeBidi: style.unicodeBidi,
                  verticalAlign: style.verticalAlign,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  katexTop: katexRect.top,
                  katexBottom: katexRect.bottom,
                }
              },
            )
            const result = {
              surface,
              width,
              hostDirection: getComputedStyle(host).direction,
              hostLeft: hostRect.left,
              hostRight: hostRect.right,
              hostScrollLeak: host.scrollWidth - host.clientWidth,
              beforeText: host.querySelector('[data-boundary="before"]')?.textContent,
              afterText: host.querySelector('[data-boundary="after"]')?.textContent,
              wrappers,
            }
            host.remove()
            return result
          }),
        ),
      {
        html: rendered,
        widths: WIDTHS,
        surfaces: SURFACES,
      },
    )

    for (const result of results) {
      const label = `${result.surface}@${result.width} RTL`
      expect(result.hostDirection, label).toBe('rtl')
      expect(result.beforeText, label).toBe('前文：')
      expect(result.afterText, label).toBe('：后文')
      expect(result.hostScrollLeak, label).toBeLessThanOrEqual(1)
      result.wrappers.forEach((wrapper, index) => {
        expect(wrapper.annotation, label).toBe(ADJACENT_FORMULAS[index])
        expect(wrapper.baseTopSpread, label).toBeLessThanOrEqual(1)
        expect(wrapper.direction, label).toBe('ltr')
        expect(wrapper.unicodeBidi, label).toBe('isolate')
        expect(wrapper.verticalAlign, label).toBe('middle')
        expect(wrapper.left, label).toBeGreaterThanOrEqual(result.hostLeft - 1)
        expect(wrapper.right, label).toBeLessThanOrEqual(result.hostRight + 1)
        expect(wrapper.katexTop, label).toBeGreaterThanOrEqual(wrapper.top - 1)
        expect(wrapper.katexBottom, label).toBeLessThanOrEqual(wrapper.bottom + 1)
      })
    }
  })

  test('contains an overlong equation and scrolls it inside its own wrapper', async ({ page }) => {
    const rendered = renderFormula(LONG_FORMULA)

    const results = await page.evaluate(
      ({ html, widths, surfaces }) =>
        surfaces.flatMap((surface) =>
          widths.flatMap((width) =>
            (['ltr', 'rtl'] as const).map((direction) => {
              const host = document.createElement('div')
              host.dir = direction
              host.className = surface === 'user' ? 'hc-msg__text' : 'markdown-body'
              host.style.cssText = [
                'position:fixed',
                'left:20px',
                'top:20px',
                `width:${width}px`,
                'font-size:14px',
                'line-height:1.7',
                'white-space:pre-wrap',
                'word-break:break-word',
              ].join(';')
              const equation = `<span class="${surface === 'user' ? 'hc-msg__math ' : ''}hc-math-inline">${html}</span>`
              host.innerHTML =
                surface === 'user'
                  ? `<span>前文：</span>${equation}<span>：后文</span>`
                  : `<p><span>前文：</span>${equation}<span>：后文</span></p>`
              document.body.appendChild(host)

              const wrapper = host.querySelector<HTMLElement>('.hc-math-inline')!
              const hostRect = host.getBoundingClientRect()
              const wrapperRect = wrapper.getBoundingClientRect()
              const baseTops = Array.from(
                wrapper.querySelectorAll<HTMLElement>('.katex-html > .base'),
              ).map((base) => base.getBoundingClientRect().top)
              const style = getComputedStyle(wrapper)
              const katexRect = wrapper
                .querySelector<HTMLElement>('.katex')!
                .getBoundingClientRect()
              wrapper.scrollLeft = wrapper.scrollWidth
              const result = {
                surface,
                width,
                direction,
                annotation:
                  wrapper.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
                  '',
                baseTopSpread:
                  baseTops.length > 0 ? Math.max(...baseTops) - Math.min(...baseTops) : Number.NaN,
                overflowX: style.overflowX,
                verticalAlign: style.verticalAlign,
                wrapperLeft: wrapperRect.left,
                wrapperRight: wrapperRect.right,
                wrapperTop: wrapperRect.top,
                wrapperBottom: wrapperRect.bottom,
                katexTop: katexRect.top,
                katexBottom: katexRect.bottom,
                wrapperClientWidth: wrapper.clientWidth,
                wrapperScrollWidth: wrapper.scrollWidth,
                wrapperScrollLeft: wrapper.scrollLeft,
                hostLeft: hostRect.left,
                hostRight: hostRect.right,
                hostScrollLeak: host.scrollWidth - host.clientWidth,
                pageScrollLeak:
                  document.documentElement.scrollWidth - document.documentElement.clientWidth,
              }
              host.remove()
              return result
            }),
          ),
        ),
      {
        html: rendered,
        widths: WIDTHS,
        surfaces: SURFACES,
      },
    )

    for (const result of results) {
      const label = `${result.surface}@${result.width} ${result.direction}`
      expect(result.annotation, label).toBe(LONG_FORMULA)
      expect(result.baseTopSpread, label).toBeLessThanOrEqual(1)
      expect(result.overflowX, label).toBe('auto')
      expect(result.verticalAlign, label).toBe('middle')
      expect(result.wrapperScrollWidth, label).toBeGreaterThan(result.wrapperClientWidth + 1)
      expect(result.wrapperScrollLeft, label).toBeGreaterThan(0)
      expect(result.wrapperLeft, label).toBeGreaterThanOrEqual(result.hostLeft - 1)
      expect(result.wrapperRight, label).toBeLessThanOrEqual(result.hostRight + 1)
      expect(result.katexTop, label).toBeGreaterThanOrEqual(result.wrapperTop - 1)
      expect(result.katexBottom, label).toBeLessThanOrEqual(result.wrapperBottom + 1)
      expect(result.hostScrollLeak, label).toBeLessThanOrEqual(1)
      expect(result.pageScrollLeak, label).toBeLessThanOrEqual(1)
    }
  })

  test('keeps display math outside the inline scroll contract', async ({ page }) => {
    const displayFormula = String.raw`\frac{3}{4} + \frac{1}{4} = 1`
    const rendered = renderFormula(displayFormula, true)

    const result = await page.evaluate(
      ({ html }) => {
        const host = document.createElement('div')
        host.className = 'markdown-body'
        host.style.cssText = 'position:fixed;left:20px;top:20px;width:320px'
        host.innerHTML = html
        document.body.appendChild(host)

        const display = host.querySelector<HTMLElement>('.katex-display')!
        const style = getComputedStyle(display)
        const result = {
          annotation:
            display.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '',
          hasInlineClass: display.classList.contains('hc-math-inline'),
          inlineAncestor: display.closest('.hc-math-inline') !== null,
          display: style.display,
        }
        host.remove()
        return result
      },
      { html: rendered },
    )

    expect(result.annotation).toBe(displayFormula)
    expect(result.hasInlineClass).toBe(false)
    expect(result.inlineAncestor).toBe(false)
    expect(result.display).toBe('block')
  })
})
