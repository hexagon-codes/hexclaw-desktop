import { randomUUID } from 'node:crypto'
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import {
  DESKTOP_USER_ID,
  assertCanonicalContent,
  assertLiveRuntime,
  assertRenderManifest,
  attachJSON,
  cleanupLiveSession,
  envValue,
  lastAssistantWithMarker,
  listHistory,
  liveAppURL,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
  metadataOf,
  sha256Text,
  type HistoryMessage,
  type MessageContentEvidence,
} from './k12-live-helpers'

const blockers = liveGateBlockers({ isolatedProfile: true, model: true })

interface ChatCase {
  id: 'USR-MD-LATEX-001' | 'USR-MD-LATEX-003' | 'USR-MD-LATEX-004'
  marker: string
  prompt: string
}

interface ChatEvidence {
  testCase: ChatCase
  message: HistoryMessage
  content: MessageContentEvidence
}

function liveCases(runID: string): ChatCase[] {
  const fractionMarker = `LIVE-FRACTION-${runID}`
  const sourcesMarker = `LIVE-SOURCES-${runID}`
  const unitsMarker = `LIVE-UNITS-${runID}`
  return [
    {
      id: 'USR-MD-LATEX-001',
      marker: fractionMarker,
      prompt: `这是发布验收，不要解释指令。请逐字保留标记 ${fractionMarker}，并只用 Markdown 输出以下结构：\n\n## 分数加法\n\n行内公式：$\\frac{1}{2}+\\frac{1}{3}=\\frac{5}{6}$。\n\n块级公式：\n\n$$\n\\frac{1}{2}+\\frac{1}{3}=\\frac{5}{6}\n$$\n\n> 先通分，再相加。`,
    },
    {
      id: 'USR-MD-LATEX-003',
      marker: sourcesMarker,
      prompt: `这是发布验收，不要解释指令。请逐字保留标记 ${sourcesMarker}，只输出 Markdown，并包含：二级标题“学习依据”；一个有序列表；一个无序列表；一个两列两行表格；一段引用；恰好两个可点击来源链接 [教育部](https://www.moe.gov.cn/) 与 [人民教育出版社](https://www.pep.com.cn/)。本条禁止任何公式、美元定界符或 LaTeX。`,
    },
    {
      id: 'USR-MD-LATEX-004',
      marker: unitsMarker,
      prompt: `这是发布验收，不要解释指令。请逐字保留标记 ${unitsMarker}，并只用 Markdown 输出以下结构：\n\n## 单位与角度\n\n- 长度：$12\\,\\mathrm{cm}$\n- 角度：$60^{\\circ}$\n\n$$\n\\begin{aligned}\nx + 20 &= 50 \\\\\nx &= 30\n\\end{aligned}\n$$\n\n行内代码必须保持为 \`$x$\`，不能把代码中的美元符号渲染成公式。`,
    },
  ]
}

async function findSessionByTitle(request: APIRequestContext, title: string): Promise<string> {
  let sessionID = ''
  await expect
    .poll(
      async () => {
        const payload = await liveJSON<{
          sessions?: Array<{ id?: string; title?: string }>
        }>(
          request,
          'GET',
          `/api/v1/sessions?user_id=${encodeURIComponent(DESKTOP_USER_ID)}&limit=500`,
        )
        const matches = (payload.sessions ?? []).filter(
          (session) => session.title === title && session.id,
        )
        if (matches.length === 1) sessionID = matches[0]!.id!
        return matches.length
      },
      { message: 'the role deep-link must create exactly one isolated live session' },
    )
    .toBe(1)
  return sessionID
}

async function cleanupSessionsByTitle(request: APIRequestContext, title: string): Promise<void> {
  if (!title) return
  const payload = await liveJSON<{
    sessions?: Array<{ id?: string; title?: string }>
  }>(request, 'GET', `/api/v1/sessions?user_id=${encodeURIComponent(DESKTOP_USER_ID)}&limit=500`)
  for (const session of payload.sessions ?? []) {
    if (session.id && session.title === title) await cleanupLiveSession(request, session.id)
  }
}

async function waitForAssistant(
  request: APIRequestContext,
  sessionID: string,
  marker: string,
): Promise<HistoryMessage> {
  let terminal: HistoryMessage | undefined
  await expect
    .poll(
      async () => {
        terminal = lastAssistantWithMarker(await listHistory(request, sessionID), marker)
        return terminal?.id ?? ''
      },
      {
        timeout: 240_000,
        intervals: [500, 1_000, 2_000, 4_000],
        message: `real model must persist a terminal assistant message for ${marker}`,
      },
    )
    .not.toBe('')
  return terminal!
}

async function sendLivePrompt(
  page: Page,
  request: APIRequestContext,
  sessionID: string,
  testCase: ChatCase,
): Promise<ChatEvidence> {
  const before = await listHistory(request, sessionID)
  await page.getByTestId('chat-input').fill(testCase.prompt)
  await page.getByTestId('chat-send').click()
  await expect(
    page.getByTestId('chat-message-user').filter({ hasText: testCase.marker }).last(),
  ).toBeVisible()

  const message = await waitForAssistant(request, sessionID, testCase.marker)
  expect(message.content).not.toMatch(/发送失败|模型未生成有效回复|模型未返回有效内容/)
  expect(
    (await listHistory(request, sessionID)).length,
    'one live turn must add both user and assistant records',
  ).toBeGreaterThanOrEqual(before.length + 2)

  const content = assertCanonicalContent(message.message_content, 'chat')
  const historyManifest = assertRenderManifest(message.render_manifest, content, 'history')
  expect(historyManifest.capability_snapshot.markdown).toBe(true)
  expect(historyManifest.capability_snapshot.tex_math).toBe(true)
  expect(historyManifest.capability_snapshot.mathml).toBe(true)

  const metadata = metadataOf(message)
  expect(
    metadata.provider,
    'persisted reply must identify the explicitly approved real provider',
  ).toBe(envValue('HEX_K12_LIVE_PROVIDER'))
  expect(metadata.model, 'persisted reply must identify the explicitly approved real model').toBe(
    envValue('HEX_K12_LIVE_MODEL'),
  )

  const assistant = page
    .getByTestId('chat-message-assistant')
    .filter({ hasText: testCase.marker })
    .last()
  await expect(assistant).toBeVisible({ timeout: 30_000 })
  const renderer = assistant.locator(`[data-source-digest="${content.source_digest}"]`).first()
  await expect(renderer, 'terminal bubble must render the persisted canonical source').toBeVisible()
  await expect(renderer).toHaveAttribute('data-content-protocol', 'canonical')
  await expect(renderer).toHaveAttribute('data-producer-kind', 'chat')
  await expect(renderer).toHaveAttribute(
    'data-render-id',
    `render:${content.content_id.slice('content:'.length)}:desktop`,
  )

  return { testCase, message, content }
}

async function rendererFor(page: Page, evidence: ChatEvidence): Promise<Locator> {
  const assistant = page
    .getByTestId('chat-message-assistant')
    .filter({ hasText: evidence.testCase.marker })
    .last()
  await expect(assistant).toBeVisible()
  const renderer = assistant
    .locator(`[data-source-digest="${evidence.content.source_digest}"]`)
    .first()
  await expect(renderer).toBeVisible()
  return renderer
}

async function visibleProjectionWithoutMathML(renderer: Locator): Promise<string> {
  return renderer.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.katex-mathml, annotation').forEach((node) => node.remove())
    return clone.textContent ?? ''
  })
}

async function assertFractionCase(page: Page, evidence: ChatEvidence): Promise<void> {
  expect(evidence.content.markdown).toContain(evidence.testCase.marker)
  expect(evidence.content.markdown).toMatch(/\\(?:d?frac|tfrac)\{1\}\{2\}/)
  expect(evidence.content.markdown).toMatch(/\\(?:d?frac|tfrac)\{1\}\{3\}/)
  expect(evidence.content.markdown).toMatch(/\\(?:d?frac|tfrac)\{5\}\{6\}/)
  const renderer = await rendererFor(page, evidence)
  await expect(renderer.locator('.markdown-body h2')).toContainText('分数加法')
  expect(await renderer.locator('.katex').count()).toBeGreaterThanOrEqual(2)
  expect(await renderer.locator('.katex-display').count()).toBeGreaterThanOrEqual(1)
  expect(
    await renderer.locator('math').count(),
    'KaTeX output must expose MathML semantics',
  ).toBeGreaterThanOrEqual(2)
  expect(
    await renderer.locator('annotation[encoding="application/x-tex"]').count(),
  ).toBeGreaterThanOrEqual(2)
  expect(await visibleProjectionWithoutMathML(renderer)).not.toContain('\\frac')
}

async function assertSourcesCase(page: Page, evidence: ChatEvidence): Promise<void> {
  expect(evidence.content.markdown).toContain(evidence.testCase.marker)
  expect(evidence.content.markdown).not.toMatch(/\\(?:frac|begin|mathrm)|\$[^$\n]+\$/)
  const renderer = await rendererFor(page, evidence)
  expect(
    await renderer.locator('.katex').count(),
    'non-math Markdown must not create formula nodes',
  ).toBe(0)
  expect(await renderer.locator('.markdown-body h2').count()).toBeGreaterThanOrEqual(1)
  expect(await renderer.locator('.markdown-body ol').count()).toBeGreaterThanOrEqual(1)
  expect(await renderer.locator('.markdown-body ul').count()).toBeGreaterThanOrEqual(1)
  expect(await renderer.locator('.markdown-body table').count()).toBeGreaterThanOrEqual(1)
  expect(await renderer.locator('.markdown-body blockquote').count()).toBeGreaterThanOrEqual(1)
  const links = await renderer
    .locator('.markdown-body a')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href))
  expect(links).toHaveLength(2)
  expect(links.some((href) => new URL(href).hostname === 'www.moe.gov.cn')).toBe(true)
  expect(links.some((href) => new URL(href).hostname === 'www.pep.com.cn')).toBe(true)
}

async function assertUnitsCase(page: Page, evidence: ChatEvidence): Promise<void> {
  expect(evidence.content.markdown).toContain(evidence.testCase.marker)
  expect(evidence.content.markdown).toMatch(/\\mathrm\{cm\}/)
  expect(evidence.content.markdown).toMatch(/\^\{\\circ\}/)
  expect(evidence.content.markdown).toContain('\\begin{aligned}')
  expect(evidence.content.markdown).toContain('`$x$`')
  const renderer = await rendererFor(page, evidence)
  expect(await renderer.locator('.katex').count()).toBeGreaterThanOrEqual(3)
  expect(await renderer.locator('.katex-display').count()).toBeGreaterThanOrEqual(1)
  expect(await renderer.locator('math').count()).toBeGreaterThanOrEqual(3)
  const inlineCode = renderer.locator('.markdown-body code').filter({ hasText: '$x$' }).first()
  await expect(inlineCode).toHaveText('$x$')
  expect(
    await inlineCode.locator('.katex').count(),
    'code literal `$x$` must not become math',
  ).toBe(0)
  expect(await visibleProjectionWithoutMathML(renderer)).not.toContain('\\begin{aligned}')
}

async function assertAllSemanticCases(page: Page, evidence: ChatEvidence[]): Promise<void> {
  await assertFractionCase(page, evidence[0]!)
  await assertSourcesCase(page, evidence[1]!)
  await assertUnitsCase(page, evidence[2]!)
}

test.describe.serial('LIVE K12 chat Markdown/LaTeX canonical rendering', () => {
  test.skip(blockers.length > 0, liveSkipReason(blockers, 'installed RC + authorized real model'))

  let sessionID = ''
  let sessionTitle = ''

  test.afterEach(async ({ request }) => {
    if (sessionID) await cleanupLiveSession(request, sessionID)
    else if (sessionTitle) await cleanupSessionsByTitle(request, sessionTitle)
    sessionID = ''
    sessionTitle = ''
  })

  test('USR 001/003/004 use one real model, canonical DOM/MathML and history replay', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const agentName = envValue('HEX_K12_LIVE_AGENT')
    const agents = await liveJSON<{ agents?: Array<{ name?: string }> }>(
      request,
      'GET',
      '/api/v1/agents',
    )
    expect(
      agents.agents?.some((agent) => agent.name === agentName),
      'approved K12 Agent must exist in the live profile',
    ).toBe(true)

    const runID = randomUUID().slice(0, 8)
    const cases = liveCases(runID)
    sessionTitle = `LIVE-MD-${runID}`
    await page.goto(
      liveAppURL(
        `/chat?role=${encodeURIComponent(agentName)}&roleTitle=${encodeURIComponent(sessionTitle)}&model=${encodeURIComponent(envValue('HEX_K12_LIVE_MODEL'))}`,
      ),
      { waitUntil: 'domcontentloaded' },
    )
    if (new URL(page.url()).pathname === '/welcome') {
      test.skip(
        true,
        'NOT RUN: release profile onboarding blocked the approved model; no model call was made',
      )
    }
    await expect(page.getByTestId('chat-input')).toBeVisible()
    await expect(
      page.locator('.k12enh-seg'),
      'the approved Agent must mount the real K12 conversation extension',
    ).toBeVisible()
    sessionID = await findSessionByTitle(request, sessionTitle)

    const evidence: ChatEvidence[] = []
    for (const testCase of cases) {
      evidence.push(await sendLivePrompt(page, request, sessionID, testCase))
    }
    await assertAllSemanticCases(page, evidence)
    await testInfo.attach('chat-final-dom.png', {
      body: await page.screenshot({
        fullPage: true,
        mask: [
          page.getByTestId('chat-message-user'),
          page.getByTestId('chat-message-assistant'),
        ],
      }),
      contentType: 'image/png',
    })

    const beforeReload = evidence.map((item) => ({
      id: item.message.id,
      content_id: item.content.content_id,
      source_digest: item.content.source_digest,
    }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('chat-input')).toBeVisible()
    const sessionRow = page.locator(`[data-session-id="${sessionID}"]`)
    await expect(sessionRow).toBeVisible()
    if (
      !(await sessionRow.evaluate((element) =>
        element.classList.contains('hc-sessions__item--active'),
      ))
    ) {
      await sessionRow.click()
    }
    await assertAllSemanticCases(page, evidence)

    const reloadedHistory = await listHistory(request, sessionID)
    for (const item of evidence) {
      const reloaded = lastAssistantWithMarker(reloadedHistory, item.testCase.marker)
      const content = assertCanonicalContent(reloaded?.message_content, 'chat')
      assertRenderManifest(reloaded?.render_manifest, content, 'history')
      expect(content.content_id).toBe(item.content.content_id)
      expect(content.source_digest).toBe(item.content.source_digest)
    }
    await testInfo.attach('chat-reloaded-dom.png', {
      body: await page.screenshot({
        fullPage: true,
        mask: [
          page.getByTestId('chat-message-user'),
          page.getByTestId('chat-message-assistant'),
        ],
      }),
      contentType: 'image/png',
    })
    await attachJSON(testInfo, 'chat-render-evidence', {
      session_id_sha256: sha256Text(sessionID),
      provider: envValue('HEX_K12_LIVE_PROVIDER'),
      model: envValue('HEX_K12_LIVE_MODEL'),
      cases: beforeReload,
      canonical_dom: true,
      mathml: true,
      history_reload: true,
      native_tauri_restart: 'separate DEVICE gate; not claimed by this browser lane',
    })
  })
})
