import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import {
  assertCanonicalContent,
  assertLiveRuntime,
  assertRenderManifest,
  attachJSON,
  cleanupLiveChild,
  liveAppURL,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
  sha256Text,
} from './k12-live-helpers'

const blockers = liveGateBlockers({ isolatedProfile: true })
const ARCHIVE_TABS = [
  ['subtab-week', '本周复习'],
  ['subtab-mistakes', '全部错题'],
  ['subtab-practicesets', '练习集'],
  ['subtab-accumulation', '积累'],
  ['subtab-works', '作品'],
] as const
const REQUIRED_ARCHIVE_ACTIONS = ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复']

interface AgentProjection {
  name?: string
  metadata?: Record<string, string>
}

interface SeedEvidence {
  mistakeID: string
  accumulationID: string
  practiceSetID: string
  workID: string
  reportDigest: string
}

async function enterAgentsWithoutBypass(page: Page): Promise<boolean> {
  await page.goto(liveAppURL('/agents'), { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过', exact: true })
  if (await skip.isVisible().catch(() => false)) {
    await skip.click()
    await page.goto(liveAppURL('/agents'), { waitUntil: 'domcontentloaded' })
  }
  return new URL(page.url()).pathname !== '/welcome'
}

async function createTutor(page: Page, childName: string): Promise<void> {
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await expect(page.getByText('创建「作业辅导助手」')).toBeVisible()
  await page.locator('.k12pf__input').first().fill(childName)
  await page.locator('.k12pf .hc-select__trigger').first().click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0)
  await page.getByText('我的智能体', { exact: false }).first().click()
  await expect(page.locator('.hc-cxcard', { hasText: childName })).toBeVisible()
}

async function resolveTutorAgent(request: APIRequestContext, childName: string): Promise<string> {
  let agentID = ''
  await expect
    .poll(
      async () => {
        const payload = await liveJSON<{ agents?: AgentProjection[] }>(
          request,
          'GET',
          '/api/v1/agents',
        )
        const matches = (payload.agents ?? []).filter(
          (agent) => agent.metadata?.['k12.child_name'] === childName && Boolean(agent.name),
        )
        if (matches.length === 1) agentID = matches[0]!.name!
        return matches.length
      },
      { message: 'the visible create flow must persist exactly one TutorAgent' },
    )
    .toBe(1)
  return agentID
}

async function seedCanonicalRecords(
  request: APIRequestContext,
  agentID: string,
  marker: string,
): Promise<SeedEvidence> {
  const mistake = await liveJSON<{ record_created: boolean; record_id?: string }>(
    request,
    'POST',
    '/api/k12/record-mistake',
    {
      agent: agentID,
      subject: '数学',
      grade: '五年级下',
      source_session: `live-records:${marker}`,
      problem: `${marker}：3/4 + 1/8 = ?`,
      student_answer: '4/12',
      error_cause: `${marker}-错因-异分母直接相加`,
      knowledge_points: [`${marker}-分数加法`],
    },
  )
  expect(mistake.record_created).toBe(true)
  expect(mistake.record_id).toBeTruthy()

  const accumulation = await liveJSON<{ record_id?: string; created?: boolean }>(
    request,
    'POST',
    '/api/k12/accumulation',
    {
      agent: agentID,
      source_session: `live-records:${marker}`,
      subject: '语文',
      entry_type: '好词好句',
      content: `${marker}-积累-雨后的树叶像洗亮的翡翠`,
      source: 'LIVE 验收合成素材',
    },
  )
  expect(accumulation.created).toBe(true)
  expect(accumulation.record_id).toBeTruthy()

  const practice = await liveJSON<{ record_id?: string; added?: boolean }>(
    request,
    'POST',
    '/api/k12/practice-sets/basket/items',
    {
      agent: agentID,
      source_session: `live-records:${marker}`,
      item: {
        subject: '数学',
        added_via: 'manual',
        question_markdown: `${marker}-练习-计算 $\\frac{3}{4}+\\frac{1}{8}$`,
        expected_answer_markdown: '$\\frac{7}{8}$',
        verification_status: 'verified',
        verification_evidence: `${marker}-独立验算`,
      },
    },
  )
  expect(practice.added).toBe(true)
  expect(practice.record_id).toBeTruthy()

  const work = await liveJSON<{ record_id?: string; created?: boolean }>(
    request,
    'POST',
    '/api/k12/creative-works',
    {
      agent: agentID,
      source_session: `live-records:${marker}`,
      work_type: 'writing',
      title: `${marker}-作品-春雨`,
      task: '写一段观察文字',
      intent: '只保存家长确认的原稿',
      content_markdown: `## ${marker}\n\n雨点落在窗台上。`,
    },
  )
  expect(work.created).toBe(true)
  expect(work.record_id).toBeTruthy()

  const report = await liveJSON<{
    message_content?: Parameters<typeof assertCanonicalContent>[0]
    render_manifest?: Parameters<typeof assertRenderManifest>[0]
  }>(request, 'GET', `/api/k12/insight-report?agent=${encodeURIComponent(agentID)}`)
  const reportContent = assertCanonicalContent(report.message_content, 'report')
  assertRenderManifest(report.render_manifest, reportContent, 'k12')

  return {
    mistakeID: mistake.record_id!,
    accumulationID: accumulation.record_id!,
    practiceSetID: practice.record_id!,
    workID: work.record_id!,
    reportDigest: reportContent.source_digest,
  }
}

async function assertRecordAPIs(
  request: APIRequestContext,
  agentID: string,
  marker: string,
  expected: SeedEvidence,
): Promise<void> {
  const mistakes = await liveJSON<{
    items?: Array<{ record_id: string; question: string; knowledge_point?: string }>
  }>(request, 'GET', `/api/k12/mistakes?agent=${encodeURIComponent(agentID)}`)
  const mistake = mistakes.items?.find((item) => item.record_id === expected.mistakeID)
  expect(Boolean(mistake), 'mistake ID must survive the real storage round trip').toBe(true)
  expect(mistake?.question.includes(marker)).toBe(true)

  const accumulation = await liveJSON<{
    items?: Array<{ record_id: string; content: string }>
  }>(request, 'GET', `/api/k12/accumulation?agent=${encodeURIComponent(agentID)}`)
  const accumulationItem = accumulation.items?.find(
    (item) => item.record_id === expected.accumulationID,
  )
  expect(
    Boolean(accumulationItem),
    'accumulation ID must survive the real storage round trip',
  ).toBe(true)
  expect(accumulationItem?.content.includes(marker)).toBe(true)

  const practices = await liveJSON<{
    items?: Array<{ record_id: string; items?: Array<{ question_markdown?: string }> }>
  }>(request, 'GET', `/api/k12/practice-sets?agent=${encodeURIComponent(agentID)}`)
  const practice = practices.items?.find((item) => item.record_id === expected.practiceSetID)
  expect(Boolean(practice), 'practice-set ID must survive the real storage round trip').toBe(true)
  expect(practice?.items?.some((item) => item.question_markdown?.includes(marker))).toBe(true)

  const works = await liveJSON<{
    items?: Array<{ record_id: string; title: string }>
  }>(request, 'GET', `/api/k12/creative-works?agent=${encodeURIComponent(agentID)}`)
  const work = works.items?.find((item) => item.record_id === expected.workID)
  expect(Boolean(work), 'creative-work ID must survive the real storage round trip').toBe(true)
  expect(work?.title.includes(marker)).toBe(true)
}

async function openArchiveTab(page: Page, testID: string, label: string): Promise<void> {
  const tab =
    testID === 'subtab-accumulation'
      ? page.locator('.k12rec__tabs .seg').getByRole('button', { name: label, exact: true })
      : page.getByTestId(testID)
  await tab.click()
  await expect(tab).toHaveClass(/on/)
}

async function assertArchiveActions(page: Page, tabName: string): Promise<void> {
  const more = page.locator('.k12rec__export > button')
  await more.click()
  const menu = page.locator('.k12rec__menu')
  await expect(menu).toBeVisible()
  const actions = (await menu.locator(':scope > button').allTextContents()).map((text) =>
    text.trim(),
  )
  for (const required of REQUIRED_ARCHIVE_ACTIONS) {
    expect(actions.includes(required), `${tabName} must expose ${required}`).toBe(true)
  }
  await more.click()
  await expect(menu).toBeHidden()
}

async function assertFiveVisibleObjects(page: Page, marker: string): Promise<void> {
  await openArchiveTab(page, 'subtab-week', '本周复习')
  await expect(page.getByTestId('week-section')).toContainText(`${marker}-分数加法`)
  await assertArchiveActions(page, '本周复习')

  await openArchiveTab(page, 'subtab-mistakes', '全部错题')
  await expect(page.getByTestId('mistakes-section')).toContainText(marker)
  await assertArchiveActions(page, '全部错题')

  await openArchiveTab(page, 'subtab-practicesets', '练习集')
  await expect(page.getByTestId('practicesets-section')).toContainText(`${marker}-练习`)
  await assertArchiveActions(page, '练习集')

  await openArchiveTab(page, 'subtab-accumulation', '积累')
  await expect(page.getByTestId('accum-prototype')).toContainText(`${marker}-积累`)
  await assertArchiveActions(page, '积累')

  await openArchiveTab(page, 'subtab-works', '作品')
  await expect(page.getByTestId('works-section')).toContainText(`${marker}-作品`)
  await assertArchiveActions(page, '作品')
}

test.describe.serial('LIVE K12 learning-record owner and persistence acceptance', () => {
  test.skip(blockers.length > 0, liveSkipReason(blockers, 'installed RC + isolated profile'))

  let childName = ''

  test.afterEach(async ({ request }) => {
    if (childName) await cleanupLiveChild(request, childName)
    childName = ''
  })

  test('visible create flow → four real record APIs → five object tabs → reload with stable IDs', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const ready = await enterAgentsWithoutBypass(page)
    test.skip(
      !ready,
      'NOT RUN: the release profile is still blocked by onboarding; no storage assertion was executed',
    )

    const marker = `LIVE-RECORDS-${randomUUID().slice(0, 8)}`
    childName = `验收${marker.slice(-8)}`
    await createTutor(page, childName)
    const agentID = await resolveTutorAgent(request, childName)
    const evidence = await seedCanonicalRecords(request, agentID, marker)
    await assertRecordAPIs(request, agentID, marker, evidence)

    const card = page.locator('.hc-cxcard', { hasText: childName })
    await card.getByRole('button', { name: /学习档案|错题本/ }).click()
    await expect(page.locator('.k12rec')).toBeVisible()
    const tabLabels = (await page.locator('.k12rec__tabs .seg > button').allTextContents()).map(
      (text) => text.trim(),
    )
    expect(tabLabels, 'learning-record object tabs are an exact-set contract').toEqual(
      ARCHIVE_TABS.map(([, label]) => label),
    )
    await assertFiveVisibleObjects(page, marker)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.k12enh-seg')).toBeVisible()
    await page.locator('.k12enh-seg').getByRole('button', { name: '学习档案', exact: true }).click()
    await expect(page.locator('.k12rec')).toBeVisible()
    await assertFiveVisibleObjects(page, marker)
    await assertRecordAPIs(request, agentID, marker, evidence)

    await attachJSON(testInfo, 'learning-record-evidence', {
      agent_identity_sha256: sha256Text(agentID),
      record_ids: {
        mistake: evidence.mistakeID,
        accumulation: evidence.accumulationID,
        practice_set: evidence.practiceSetID,
        creative_work: evidence.workID,
      },
      report_source_digest: evidence.reportDigest,
      visible_tab_exact_set: ARCHIVE_TABS.map(([, label]) => label),
      reload_verified: true,
    })
  })
})
