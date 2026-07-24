import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, extname, join, resolve } from 'node:path'

import katex from 'katex'

const [, , cssArgument, outputArgument] = process.argv

if (cssArgument === '--serve') {
  const artifactDirectory = resolve(outputArgument ?? '')
  const assetDirectory = resolve(process.argv[4] ?? '')
  const port = Number(process.argv[5])
  if (!outputArgument || !process.argv[4] || !Number.isInteger(port)) {
    console.error(
      'Usage: node tests/native/wkwebview-math-fixture.mjs ' +
        '--serve <artifact-dir> <dist-assets-dir> <port>',
    )
    process.exit(2)
  }

  const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.ttf', 'font/ttf'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
  ])
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const isAsset = pathname.startsWith('/dist-assets/')
      const requestedName = basename(pathname === '/' ? 'fixture.html' : pathname)
      const root = isAsset ? assetDirectory : artifactDirectory
      const requestedPath = join(root, requestedName)
      const fileStat = await stat(requestedPath)
      if (!fileStat.isFile()) throw new Error('not a file')
      response.statusCode = 200
      response.setHeader(
        'Content-Type',
        contentTypes.get(extname(requestedPath)) ?? 'application/octet-stream',
      )
      createReadStream(requestedPath).pipe(response)
    } catch {
      response.statusCode = 404
      response.end('not found')
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`native WKWebView fixture server: http://127.0.0.1:${port}`)
  })
  await new Promise(() => {})
}

if (!cssArgument || !outputArgument) {
  console.error('Usage: node tests/native/wkwebview-math-fixture.mjs <built-css> <output-html>')
  process.exit(2)
}

const cssInputPath = resolve(cssArgument)
const outputPath = resolve(outputArgument)
const cssInputStat = await stat(cssInputPath)
const cssPaths = cssInputStat.isDirectory()
  ? (await readdir(cssInputPath))
      .filter((name) => name.endsWith('.css'))
      .sort()
      .map((name) => join(cssInputPath, name))
  : [cssInputPath]
if (cssPaths.length === 0) {
  throw new Error(`production build has no CSS assets: ${cssInputPath}`)
}
const cssAssets = await Promise.all(
  cssPaths.map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
)
const css = cssAssets.map((asset) => asset.content).join('\n')

if (!css.includes('.hc-math-inline') || !css.includes('.hc-math-viewport')) {
  throw new Error(
    `built CSS is missing the structural math shell/viewport contract: ${cssInputPath}`,
  )
}
if (!css.includes('.hc-math-viewport--scrollable')) {
  throw new Error(`built CSS is missing the structural scroll viewport class: ${cssInputPath}`)
}
if (
  css.includes('--hc-math-scroll-padding-block-start') ||
  css.includes('--hc-math-scroll-padding-block-end')
) {
  throw new Error(
    `built CSS still contains the abandoned dynamic ink-padding contract: ${cssInputPath}`,
  )
}
if (!css.includes('KaTeX_Main')) {
  throw new Error(`built CSS is missing the bundled KaTeX fonts: ${cssInputPath}`)
}

const markdownScope = css.match(/\.markdown-body\[data-v-([a-z0-9]+)\]/)?.[1]
const messageTextScope = css.match(/\.hc-msg__math--display\[data-v-([a-z0-9]+)\]/)?.[1]
const chatViewScope = css.match(/\.hc-msg__bubble\[data-v-([a-z0-9]+)\]/)?.[1]
if (!markdownScope || !messageTextScope || !chatViewScope) {
  throw new Error(
    `built CSS is missing a MarkdownRenderer, MessageText, or ChatView scope: ${cssInputPath}`,
  )
}

const ordinarySource = String.raw`1\frac{1}{2}\times\frac{2}{3}=2\frac{1}{4}\div\frac{9}{8}=`
const displaystyleOrdinarySource = String.raw`\displaystyle ` + ordinarySource
const forcedSource = [
  displaystyleOrdinarySource,
  displaystyleOrdinarySource,
  displaystyleOrdinarySource,
  displaystyleOrdinarySource,
].join(String.raw`\quad`)
const tallUnit = String.raw`\frac{\frac{a_1}{\frac{b_1}{c_1}}+\sqrt{\frac{d_1}{e_1}}}{\frac{\frac{f_1}{g_1}}{\frac{h_1}{i_1}}}`
const displaySource = [tallUnit, tallUnit, tallUnit].join(String.raw`\quad`)
const editableFirstSource = String.raw`2\frac{3}{4}`
const editableSecondSource = String.raw`1\frac{1}{2}`

function renderKatex(source, displayMode = false) {
  return katex.renderToString(source, {
    displayMode,
    output: 'htmlAndMathml',
    strict: 'error',
    throwOnError: true,
    trust: false,
  })
}

function renderViewport(source, displayMode = false, id) {
  const layoutClass = displayMode ? 'hc-math-viewport--display' : 'hc-math-viewport--inline'
  return (
    `<span class="hc-math-viewport ${layoutClass}" data-probe-viewport="${id}">` +
    `${renderKatex(source, displayMode)}</span>`
  )
}

const ordinaryFractionCount = ordinarySource.match(/\\frac/g)?.length ?? 0
const forcedFractionCount = forcedSource.match(/\\frac/g)?.length ?? 0
const displayFractionCount = displaySource.match(/\\frac/g)?.length ?? 0
const editableFractionCount =
  (editableFirstSource.match(/\\frac/g)?.length ?? 0) +
  (editableSecondSource.match(/\\frac/g)?.length ?? 0)
const productionCssLinks = cssPaths
  .map((path) => `    <link rel="stylesheet" href="/dist-assets/${basename(path)}">`)
  .join('\n')

const cv = `data-v-${chatViewScope}`
const mt = `data-v-${messageTextScope}`
const md = `data-v-${markdownScope}`

const html = `<!doctype html>
<html
  lang="zh-CN"
  data-production-css-count="${cssPaths.length}"
  data-markdown-scope="${markdownScope}"
  data-message-text-scope="${messageTextScope}"
  data-chat-view-scope="${chatViewScope}"
>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
${productionCssLinks}
    <style>
      html, body {
        width: 100%;
        min-height: 100%;
        margin: 0;
        overflow: visible;
        background: var(--hc-bg-main, #f8fafc);
      }

      body {
        box-sizing: border-box;
        padding: 28px;
        color: var(--hc-text-primary, #16324f);
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      }

      .probe-board {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 24px;
        width: 100%;
        max-width: 1044px;
      }

      .probe-case {
        min-width: 0;
        padding: 18px;
        border: 1px solid var(--hc-border, #cbd5e1);
        border-radius: 14px;
        background: var(--hc-bg-card, #fff);
      }

      .probe-label {
        display: block;
        margin-bottom: 14px;
        color: var(--hc-text-muted, #64748b);
        font: 12px/1.4 ui-monospace, "SF Mono", monospace;
      }

      .probe-chat-lane {
        display: flex;
        width: 100%;
        min-width: 0;
      }

      [data-probe-case="forced-overflow"] .probe-chat-lane,
      [data-probe-case="display"] .probe-chat-lane {
        width: 238px;
      }

      [data-probe-case="forced-overflow"] .hc-msg__body--user {
        width: 238px !important;
        max-width: 238px !important;
      }

      [data-probe-case="display"] .markdown-body {
        width: 206px;
      }

      [data-probe-case="editable"] .hc-msg__edit-card {
        width: 100%;
        margin: 0;
        /* Headless WKWebView does not advance CSS animations while its window
           is prohibited. Pin the existing edit card to its real final frame. */
        animation: none !important;
        opacity: 1;
        transform: none;
      }

      [data-probe-case="editable"] .hc-msg__text--editable {
        min-height: 74px;
      }

      [data-overflow-axis-probe] {
        position: absolute;
        left: -10000px;
        width: 20px;
        height: 20px;
        overflow-x: auto;
        overflow-y: visible;
      }

      [data-overflow-axis-probe] > span {
        display: block;
        width: 100px;
        height: 40px;
      }
    </style>
  </head>
  <body>
    <div data-overflow-axis-probe aria-hidden="true"><span></span></div>
    <main class="probe-board">
      <section
        class="probe-case"
        data-probe-case="ordinary"
        data-surface="MessageText user bubble"
        data-expected-fractions="${ordinaryFractionCount}"
        data-expects-scroll="false"
      >
        <span class="probe-label">ordinary · real user-message bubble</span>
        <div class="probe-chat-lane">
          <div class="hc-msg hc-msg--user" ${cv}>
            <div class="hc-msg__body hc-msg__body--user" ${cv}>
              <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user" ${cv}>
                <div class="hc-msg__bubble hc-msg__bubble--user" ${cv}>
                  <div class="hc-msg__text-wrap" ${mt}>
                    <div class="hc-msg__text" ${mt}>
                      <span
                        class="hc-msg__math hc-math-inline"
                        data-math-shell
                        ${mt}
                      >${renderViewport(ordinarySource, false, 'ordinary')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        class="probe-case"
        data-probe-case="forced-overflow"
        data-surface="MessageText narrow user bubble"
        data-expected-fractions="${forcedFractionCount}"
        data-expects-scroll="true"
      >
        <span class="probe-label">forced overflow · narrow displaystyle user formula</span>
        <div class="probe-chat-lane">
          <div class="hc-msg hc-msg--user" ${cv}>
            <div class="hc-msg__body hc-msg__body--user" ${cv}>
              <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user" ${cv}>
                <div class="hc-msg__bubble hc-msg__bubble--user" ${cv}>
                  <div class="hc-msg__text-wrap" ${mt}>
                    <div class="hc-msg__text" ${mt}>
                      <span
                        class="hc-msg__math hc-math-inline"
                        data-math-shell
                        ${mt}
                      >${renderViewport(forcedSource, false, 'forced-overflow')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        class="probe-case"
        data-probe-case="display"
        data-surface="MarkdownRenderer display math"
        data-expected-fractions="${displayFractionCount}"
        data-expects-scroll="true"
      >
        <span class="probe-label">display · deeply nested MarkdownRenderer formula</span>
        <div class="probe-chat-lane">
          <div class="hc-msg hc-msg--assistant" ${cv}>
            <div class="hc-msg__body" ${cv}>
              <div class="hc-msg__bubble hc-msg__bubble--assistant" ${cv}>
                <div ${md}>
                  <div class="markdown-body" ${md}>
                    <p class="katex-block" data-math-shell>${renderViewport(
                      displaySource,
                      true,
                      'display',
                    )}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        class="probe-case"
        data-probe-case="editable"
        data-surface="MessageText edit card"
        data-expected-fractions="${editableFractionCount}"
        data-expects-scroll="false"
      >
        <span class="probe-label">editable · real edit-card projection</span>
        <div class="probe-chat-lane">
          <div class="hc-msg hc-msg--user" ${cv}>
            <div class="hc-msg__body hc-msg__body--user" ${cv}>
              <div class="hc-msg__bubble-wrap hc-msg__bubble-wrap--user" ${cv}>
                <div class="hc-msg__edit-card" ${cv}>
                  <div class="hc-msg__text-wrap hc-msg__edit-textarea" ${mt}>
                    <div
                      class="hc-msg__text hc-msg__text--editable"
                      contenteditable="true"
                      role="textbox"
                      aria-multiline="true"
                      data-testid="message-math-editor"
                      ${mt}
                    ><span data-edit-text>修路队修一条公路，第一天修了 </span><span
                        class="hc-msg__math hc-math-inline"
                        contenteditable="false"
                        data-edit-math-state="rendered"
                        data-formula-markdown="$${editableFirstSource}$"
                        data-math-shell
                        ${mt}
                      >${renderViewport(editableFirstSource, false, 'editable-first')}</span><span
                        data-edit-text
                      > 千米，第二天比第一天多修了 </span><span
                        class="hc-msg__math hc-math-inline"
                        contenteditable="false"
                        data-edit-math-state="rendered"
                        data-formula-markdown="$${editableSecondSource}$"
                        data-math-shell
                        ${mt}
                      >${renderViewport(editableSecondSource, false, 'editable-second')}</span><span
                        data-edit-text
                      > 千米。第二天修了多少千米？</span></div>
                  </div>
                  <div class="hc-msg__edit-actions" ${cv}>
                    <button class="hc-msg__edit-btn hc-msg__edit-btn--cancel" ${cv}>取消</button>
                    <button class="hc-msg__edit-btn hc-msg__edit-btn--send" ${cv}>发送</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <script>
      document.documentElement.dataset.mathSync = 'booting';
      const syncStructuralMathViewports = () => {
        const viewports = Array.from(document.querySelectorAll('.hc-math-viewport'));
        let scrollableCount = 0;
        for (const viewport of viewports) {
          viewport.classList.remove('hc-math-viewport--scrollable');
          viewport.removeAttribute('tabindex');
          const needsScroll =
            viewport.clientWidth > 0 &&
            viewport.scrollWidth > viewport.clientWidth + 1;
          viewport.dataset.classificationNeeded = String(needsScroll);
          if (!needsScroll) {
            viewport.scrollLeft = 0;
            continue;
          }
          viewport.classList.add('hc-math-viewport--scrollable');
          viewport.tabIndex = 0;
          scrollableCount += 1;
        }
        return { viewportCount: viewports.length, scrollableCount };
      };

      window.__runHexNativeStructuralSync = async () => {
        try {
          document.documentElement.dataset.mathSync = 'running';
          const initiallyScrollable = document.querySelectorAll(
            '.hc-math-viewport--scrollable'
          ).length;
          const first = syncStructuralMathViewports();
          await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
          const second = syncStructuralMathViewports();
          window.__hexNativeMathSync = {
            initiallyScrollable,
            viewportCount: second.viewportCount,
            firstScrollableCount: first.scrollableCount,
            secondScrollableCount: second.scrollableCount,
          };
          document.documentElement.dataset.mathSync = 'complete';
        } catch (error) {
          document.documentElement.dataset.mathSync = 'failed';
          document.documentElement.dataset.mathSyncError = String(error);
        }
      };
      document.documentElement.dataset.mathSync = 'waiting-for-native-font-check';
    </script>
  </body>
</html>
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, html, 'utf8')

console.log(
  JSON.stringify({
    cssInputPath,
    cssPaths,
    outputPath,
    ordinaryFractionCount,
    forcedFractionCount,
    displayFractionCount,
    editableFractionCount,
    markdownScope,
    messageTextScope,
    chatViewScope,
  }),
)
