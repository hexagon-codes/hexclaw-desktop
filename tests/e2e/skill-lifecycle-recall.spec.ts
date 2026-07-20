import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  assertLiveRuntime,
  liveGateBlockers,
  liveJSON,
  liveSidecarURL,
  liveSkipReason,
} from '../live/k12-live-helpers'

/** SKILLEVAL-001..030: exact-set lifecycle evidence plus query-level routing metrics. */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const PRIMARY = [
  'grade-constraint',
  'k12-pedagogy',
  'math-tutor',
  'chinese-tutor',
  'english-tutor',
  'science-tutor',
  'information-technology-tutor',
  'art-feedback',
  'homework-checker',
  'exercise-generator',
  'concept-explainer',
  'writing-feedback',
] as const
const TRANSITIVE = [
  'reading-comprehension',
  'classical-chinese',
  'english-vocab-coach',
  'quiz-generator',
] as const
const EXACT_SET = [...PRIMARY, ...TRANSITIVE]
const BASE = ['grade-constraint', 'k12-pedagogy'] as const
const EXPECTED_DEPENDS: Record<(typeof EXACT_SET)[number], readonly string[]> = {
  'grade-constraint': [],
  'k12-pedagogy': ['grade-constraint'],
  'math-tutor': ['grade-constraint', 'k12-pedagogy'],
  'chinese-tutor': [
    'grade-constraint',
    'k12-pedagogy',
    'reading-comprehension',
    'classical-chinese',
    'concept-explainer',
  ],
  'english-tutor': [
    'grade-constraint',
    'k12-pedagogy',
    'english-vocab-coach',
    'reading-comprehension',
    'concept-explainer',
  ],
  'science-tutor': ['grade-constraint', 'k12-pedagogy', 'concept-explainer'],
  'information-technology-tutor': ['grade-constraint', 'k12-pedagogy', 'concept-explainer'],
  'art-feedback': ['grade-constraint', 'k12-pedagogy'],
  'homework-checker': [
    'grade-constraint',
    'k12-pedagogy',
    'math-tutor',
    'chinese-tutor',
    'english-tutor',
    'science-tutor',
    'information-technology-tutor',
    'concept-explainer',
  ],
  'exercise-generator': ['grade-constraint', 'k12-pedagogy', 'quiz-generator'],
  'concept-explainer': ['grade-constraint', 'k12-pedagogy'],
  'writing-feedback': ['grade-constraint', 'k12-pedagogy', 'chinese-tutor'],
  'reading-comprehension': [],
  'classical-chinese': [],
  'english-vocab-coach': [],
  'quiz-generator': [],
}
const OPERATIONS = [
  'UPLOAD',
  'INSTALL',
  'LIST',
  'CONTENT',
  'DISABLE',
  'ENABLE',
  'UPGRADE',
  'RESTART',
  'UNINSTALL',
  'REINSTALL',
] as const

type Operation = (typeof OPERATIONS)[number]
type Json = Record<string, unknown>

interface RankedSkill {
  skill_id: string
  score: number
}

interface QueryEvidence {
  id: string
  bucket: string
  kind: 'positive' | 'hard_negative' | 'multi_intent' | 'blind'
  gold: string[]
  forbidden: string[]
  eligible: string[]
  ranking: RankedSkill[]
  selected: string[]
  matched: string[]
  mounted: string[]
  injected: string[]
  tool_skill_ids: string[]
  executed: string[]
  skill_state: 'enabled' | 'disabled' | 'uninstalled'
  state_skill_id?: string
  trace_id: string
}

interface LifecycleLeaf {
  operation: Operation
  status: 'PASS' | 'FAIL' | 'NOT_RUN'
  evidence_id: string
  before_digest: string
  after_digest: string
}

interface SkillEvidence {
  id: string
  version: string
  source_sha256: string
  tier: 'primary' | 'transitive'
  depends: string[]
  lifecycle: LifecycleLeaf[]
}

interface SkillEvalManifest {
  schema_version: string
  source: 'real'
  profile_id: string
  generated_at: string
  skills: SkillEvidence[]
  queries: QueryEvidence[]
  residual: {
    registry: string[]
    files: string[]
    cache_keys: string[]
    disabled_entries: string[]
    agent_bindings: string[]
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function intersectionCount(left: string[], right: string[]): number {
  const rightSet = new Set(right)
  return unique(left).filter((item) => rightSet.has(item)).length
}

function recallAt(query: QueryEvidence, k: number): number {
  if (!query.gold.length) return 1
  return (
    intersectionCount(
      query.gold,
      query.ranking.slice(0, k).map((item) => item.skill_id),
    ) / unique(query.gold).length
  )
}

function reciprocalRankAt5(query: QueryEvidence): number {
  const target =
    query.gold.find((skill) => !BASE.includes(skill as (typeof BASE)[number])) || query.gold[0]
  if (!target) return 1
  const index = query.ranking.slice(0, 5).findIndex((item) => item.skill_id === target)
  return index < 0 ? 0 : 1 / (index + 1)
}

function dcg(relevance: number[]): number {
  return relevance.reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0)
}

function ndcgAt(query: QueryEvidence, k: number): number {
  if (!query.gold.length) return 1
  const gold = new Set(query.gold)
  const gain = (skill: string): number => {
    if (!gold.has(skill)) return 0
    if (BASE.includes(skill as (typeof BASE)[number])) return 1
    if (TRANSITIVE.includes(skill as (typeof TRANSITIVE)[number])) return 2
    return 3
  }
  const actual = query.ranking.slice(0, k).map((item) => gain(item.skill_id))
  const ideal = unique(query.gold)
    .map(gain)
    .sort((left, right) => right - left)
    .slice(0, k)
  return dcg(actual) / dcg(ideal)
}

function aggregateRecallAt(queries: QueryEvidence[], k: number): number {
  const denominator = queries.reduce((sum, query) => sum + unique(query.gold).length, 0)
  if (!denominator) return 1
  return (
    queries.reduce(
      (sum, query) =>
        sum +
        intersectionCount(
          query.gold,
          query.ranking.slice(0, k).map((item) => item.skill_id),
        ),
      0,
    ) / denominator
  )
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function assertQueryTrace(query: QueryEvidence): void {
  expect(query.id).not.toBe('')
  expect(query.trace_id, `${query.id} must be tied to a real TutorAgent/chat trace`).not.toBe('')
  expect(unique(query.eligible), `${query.id} eligible-set contains duplicates`).toEqual(
    query.eligible,
  )
  expect(unique(query.selected), `${query.id} selected-set contains duplicates`).toEqual(
    query.selected,
  )
  expect(unique(query.matched), `${query.id} matched-set contains duplicates`).toEqual(
    query.matched,
  )
  expect(unique(query.mounted), `${query.id} mounted-set contains duplicates`).toEqual(
    query.mounted,
  )
  expect(unique(query.injected), `${query.id} injected-set contains duplicates`).toEqual(
    query.injected,
  )
  expect(unique(query.tool_skill_ids), `${query.id} tool-set contains duplicates`).toEqual(
    query.tool_skill_ids,
  )
  expect(unique(query.executed), `${query.id} executed-set contains duplicates`).toEqual(
    query.executed,
  )
  expect(
    unique(query.ranking.map((item) => item.skill_id)),
    `${query.id} ranking contains duplicate skills`,
  ).toEqual(query.ranking.map((item) => item.skill_id))
  if (query.skill_state === 'enabled' && query.gold.length) {
    expect(
      query.ranking.length,
      `${query.id} must retain the raw ranking, not only a winner`,
    ).toBeGreaterThan(0)
  }
  for (let index = 1; index < query.ranking.length; index += 1) {
    expect(
      query.ranking[index]!.score,
      `${query.id} ranking must be score-descending`,
    ).toBeLessThanOrEqual(query.ranking[index - 1]!.score)
  }
  for (const ranked of query.ranking)
    expect(query.eligible, `${query.id}: ranked ${ranked.skill_id} was not eligible`).toContain(
      ranked.skill_id,
    )
  for (const selected of query.selected)
    expect(query.eligible, `${query.id}: selected ${selected} was not eligible`).toContain(selected)
  for (const matched of query.matched)
    expect(query.selected, `${query.id}: matched ${matched} was not selected`).toContain(matched)
  for (const executed of query.executed)
    expect(query.mounted, `${query.id}: executed ${executed} was not mounted`).toContain(executed)
  for (const injected of query.injected)
    expect(query.mounted, `${query.id}: injected ${injected} was not mounted`).toContain(injected)
  for (const tool of query.tool_skill_ids)
    expect(query.mounted, `${query.id}: tool ${tool} was not mounted`).toContain(tool)
  for (const forbidden of query.forbidden) {
    expect(
      query.eligible,
      `${query.id}: forbidden ${forbidden} entered eligible-set`,
    ).not.toContain(forbidden)
    expect(
      query.ranking.map((item) => item.skill_id),
      `${query.id}: forbidden ${forbidden} entered ranking`,
    ).not.toContain(forbidden)
    expect(query.selected, `${query.id}: forbidden ${forbidden} was selected`).not.toContain(
      forbidden,
    )
    expect(query.matched, `${query.id}: forbidden ${forbidden} was matched`).not.toContain(
      forbidden,
    )
    expect(query.mounted, `${query.id}: forbidden ${forbidden} was mounted`).not.toContain(
      forbidden,
    )
    expect(query.injected, `${query.id}: forbidden ${forbidden} was injected`).not.toContain(
      forbidden,
    )
    expect(
      query.tool_skill_ids,
      `${query.id}: forbidden ${forbidden} exposed a tool`,
    ).not.toContain(forbidden)
    expect(query.executed, `${query.id}: forbidden ${forbidden} executed`).not.toContain(forbidden)
  }
  if (query.skill_state !== 'enabled') {
    expect(
      query.state_skill_id,
      `${query.id} ${query.skill_state} leaf must identify the affected Skill`,
    ).toBeTruthy()
    const allLayers = [
      ...query.eligible,
      ...query.ranking.map((item) => item.skill_id),
      ...query.selected,
      ...query.matched,
      ...query.mounted,
      ...query.injected,
      ...query.tool_skill_ids,
      ...query.executed,
    ]
    expect(
      allLayers,
      `${query.id}: ${query.state_skill_id} leaked while ${query.skill_state}`,
    ).not.toContain(query.state_skill_id)
  }
}

function loadManifest(path: string): SkillEvalManifest {
  expect(statSync(path).isFile(), 'eval manifest must be a regular evidence file').toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as SkillEvalManifest
}

async function skillsSnapshot(request: APIRequestContext): Promise<Json[]> {
  const payload = await liveJSON<{ skills?: Json[] }>(request, 'GET', '/api/v1/skills')
  return [...(payload.skills || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function frontmatter(path: string): {
  name: string
  version: string
  sha256: string
  content: string
} {
  const content = readFileSync(path, 'utf8')
  const name = /^name:\s*["']?([^\n"']+)/m.exec(content)?.[1]?.trim() || ''
  const version = /^version:\s*["']?([^\n"']+)/m.exec(content)?.[1]?.trim() || ''
  expect(name, 'test Skill package must declare frontmatter.name').not.toBe('')
  expect(version, 'test Skill package must declare frontmatter.version').not.toBe('')
  return { name, version, sha256: createHash('sha256').update(content).digest('hex'), content }
}

async function uninstallFromUI(page: Page, skillName: string): Promise<void> {
  const card = page.locator('.hc-card-interactive').filter({ hasText: skillName })
  await card.getByTitle('删除').click()
  const confirm = page.locator('.fixed.inset-0.z-50').filter({ hasText: skillName }).last()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname.endsWith(`/api/v1/skills/${encodeURIComponent(skillName)}`),
  )
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  expect((await responsePromise).ok()).toBe(true)
  await expect(card).toHaveCount(0, { timeout: 120_000 })
}

test('SKILLEVAL-025 metric oracle catches wrong Recall/MRR/nDCG implementations', () => {
  const query: QueryEvidence = {
    id: 'metric-oracle',
    bucket: 'subject',
    kind: 'multi_intent',
    gold: ['math-tutor', 'writing-feedback'],
    forbidden: [],
    eligible: ['math-tutor', 'english-tutor', 'writing-feedback'],
    ranking: [
      { skill_id: 'math-tutor', score: 0.9 },
      { skill_id: 'english-tutor', score: 0.8 },
      { skill_id: 'writing-feedback', score: 0.7 },
    ],
    selected: ['math-tutor', 'writing-feedback'],
    matched: ['math-tutor', 'writing-feedback'],
    mounted: ['math-tutor', 'writing-feedback'],
    injected: ['math-tutor', 'writing-feedback'],
    tool_skill_ids: [],
    executed: ['math-tutor', 'writing-feedback'],
    skill_state: 'enabled',
    trace_id: 'metric-oracle-trace',
  }
  expect(recallAt(query, 1)).toBe(0.5)
  expect(recallAt(query, 3)).toBe(1)
  expect(aggregateRecallAt([query], 3)).toBe(1)
  expect(reciprocalRankAt5(query)).toBe(1)
  expect(ndcgAt(query, 3)).toBeCloseTo((3 + 3 / 2) / (3 + 3 / Math.log2(3)), 10)
})

test.describe.serial('real Skill install and runtime state', () => {
  test.setTimeout(12 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real model'),
  )

  let installedSkillName = ''

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test.afterEach(async ({ request }) => {
    if (!installedSkillName) return
    const deleting = installedSkillName
    installedSkillName = ''
    const response = await request.delete(
      liveSidecarURL(`/api/v1/skills/${encodeURIComponent(deleting)}`),
    )
    expect(
      [200, 204, 404],
      `DELETE /api/v1/skills/:name => HTTP ${response.status()} (body redacted)`,
    ).toContain(response.status())
  })

  test('visible local-file install → content → disable/restart/enable → uninstall/reinstall → exact restore', async ({
    page,
    request,
  }) => {
    const packagePath = process.env.HEX_K12_SKILL_PACKAGE
    test.skip(
      !packagePath,
      'NOT RUN: HEX_K12_SKILL_PACKAGE must point to the reviewed local SKILL.md test package',
    )
    const pkg = frontmatter(packagePath!)
    const before = await skillsSnapshot(request)
    expect(
      before.some((skill) => skill.name === pkg.name),
      `refusing to overwrite pre-existing Skill ${pkg.name}`,
    ).toBe(false)
    installedSkillName = pkg.name

    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    await page.goto('/integration?action=skill-install', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('安装 Skill', { exact: false }).last()).toBeVisible()
    const requestPromise = page.waitForRequest(
      (req) =>
        req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/v1/skills/install'),
    )
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /选择文件/ }).click()
    const chooser = await chooserPromise
    await chooser.setFiles(packagePath!)
    const installRequest = await requestPromise
    expect(installRequest.postDataJSON()).toMatchObject({ type: 'file' })
    const installResponse = await installRequest.response()
    expect(
      installResponse?.ok(),
      'file installation must reach a successful real registry terminal',
    ).toBe(true)

    const card = page.locator('.hc-card-interactive').filter({ hasText: pkg.name })
    await expect(card).toBeVisible({ timeout: 120_000 })
    await expect(card).toContainText(pkg.version)
    await card.getByRole('button', { name: pkg.name, exact: true }).click()
    const preview = page
      .locator('[role="dialog"], .fixed.inset-0')
      .filter({ hasText: pkg.name })
      .last()
    await expect(preview).toContainText(
      pkg.content
        .split('\n')
        .find((line) => line.startsWith('# '))
        ?.slice(2) || pkg.name,
    )
    await preview.getByRole('button', { name: /关闭/ }).click()

    let toggleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith(
          `/api/v1/skills/${encodeURIComponent(pkg.name)}/status`,
        ),
    )
    await card.getByTitle(/禁用/).click()
    expect((await toggleResponse).ok()).toBe(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(
      page.locator('.hc-card-interactive').filter({ hasText: pkg.name }).getByTitle(/启用/),
    ).toBeVisible({ timeout: 120_000 })

    toggleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith(
          `/api/v1/skills/${encodeURIComponent(pkg.name)}/status`,
        ),
    )
    await page
      .locator('.hc-card-interactive')
      .filter({ hasText: pkg.name })
      .getByTitle(/启用/)
      .click()
    expect((await toggleResponse).ok()).toBe(true)
    await uninstallFromUI(page, pkg.name)

    await page.goto('/integration?action=skill-install', { waitUntil: 'domcontentloaded' })
    const reinstallRequest = page.waitForRequest(
      (req) =>
        req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/v1/skills/install'),
    )
    const reinstallChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /选择文件/ }).click()
    await (await reinstallChooser).setFiles(packagePath!)
    expect((await (await reinstallRequest).response())?.ok()).toBe(true)
    await expect(page.locator('.hc-card-interactive').filter({ hasText: pkg.name })).toBeVisible({
      timeout: 120_000,
    })
    await uninstallFromUI(page, pkg.name)
    installedSkillName = ''
    expect(
      await skillsSnapshot(request),
      'registry/version/enabled state must return to its exact pre-test snapshot',
    ).toEqual(before)
  })
})

test.describe('K12 Skill exact-set lifecycle and real recall evidence', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real model'),
  )

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test('16 Skills × 10 operations and every query trace meet the frozen gates', () => {
    const manifestPath = process.env.HEX_K12_SKILL_EVAL_MANIFEST
    test.skip(
      !manifestPath,
      'NOT RUN: HEX_K12_SKILL_EVAL_MANIFEST is required; a source-tree snapshot or NOT_RUN ledger is not execution evidence',
    )
    const manifest = loadManifest(manifestPath!)
    expect(manifest.schema_version).toBe('k12-skill-eval/v1')
    expect(manifest.source).toBe('real')
    expect(
      manifest.profile_id,
      'runner must identify the isolated profile it mutated and restored',
    ).not.toBe('')
    expect(Date.parse(manifest.generated_at)).not.toBeNaN()

    expect(
      manifest.skills.map((skill) => skill.id).sort(),
      '12 primary + 4 transitive exact-set',
    ).toEqual([...EXACT_SET].sort())
    expect(
      new Set(manifest.skills.map((skill) => skill.id)).size,
      'Skill ledger must not hide duplicate ids',
    ).toBe(EXACT_SET.length)
    for (const skill of manifest.skills) {
      expect(skill.tier).toBe(
        PRIMARY.includes(skill.id as (typeof PRIMARY)[number]) ? 'primary' : 'transitive',
      )
      expect(skill.version).not.toBe('')
      expect(skill.source_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect([...skill.depends].sort(), `${skill.id} direct dependency exact-set`).toEqual(
        [...EXPECTED_DEPENDS[skill.id as (typeof EXACT_SET)[number]]].sort(),
      )
      expect(
        skill.lifecycle.map((leaf) => leaf.operation),
        `${skill.id} lifecycle exact-set`,
      ).toEqual(OPERATIONS)
      for (const leaf of skill.lifecycle) {
        expect(leaf.status, `${skill.id}/${leaf.operation} is not real PASS evidence`).toBe('PASS')
        expect(leaf.evidence_id).not.toBe('')
        expect(leaf.before_digest).toMatch(/^[a-f0-9]{64}$/)
        expect(leaf.after_digest).toMatch(/^[a-f0-9]{64}$/)
      }
    }

    expect(
      manifest.queries.length,
      'blind/regression/hard-negative corpus must contain per-query leaves',
    ).toBeGreaterThanOrEqual(16 * 50)
    for (const query of manifest.queries) assertQueryTrace(query)
    const positives = manifest.queries.filter((query) => query.gold.length > 0)
    const hardNegatives = manifest.queries.filter((query) => query.kind === 'hard_negative')
    const subject = positives.filter((query) => query.bucket === 'subject')
    const basePositives = positives.filter((query) => query.bucket === 'base')
    const safety = manifest.queries.filter((query) => query.bucket === 'safety')

    expect(
      positives.length,
      'each callable Skill requires at least 30 positive leaves',
    ).toBeGreaterThanOrEqual(16 * 30)
    expect(
      hardNegatives.length,
      'each callable Skill requires at least 20 reviewed hard-negative leaves',
    ).toBeGreaterThanOrEqual(16 * 20)
    expect(aggregateRecallAt(positives, 1), 'overall micro Recall@1').toBeGreaterThanOrEqual(0.9)
    expect(
      mean(positives.map((query) => recallAt(query, 3))),
      'macro Recall@3',
    ).toBeGreaterThanOrEqual(0.98)
    expect(
      mean(positives.map(reciprocalRankAt5)),
      'MRR@5, first primary target',
    ).toBeGreaterThanOrEqual(0.95)
    expect(
      mean(positives.map((query) => ndcgAt(query, 5))),
      'weighted nDCG@5 (primary=3/transitive=2/base=1)',
    ).toBeGreaterThanOrEqual(0.95)
    expect(
      mean(positives.map((query) => (recallAt(query, 5) === 1 ? 1 : 0))),
      'AllGold@5',
    ).toBeGreaterThanOrEqual(0.95)
    expect(
      mean(subject.map((query) => recallAt(query, 1))),
      'subject Top-1',
    ).toBeGreaterThanOrEqual(0.98)
    expect(basePositives.length, 'base effective-injection gate needs real leaves').toBeGreaterThan(
      0,
    )
    expect(
      basePositives.every((query) => query.gold.every((skill) => query.injected.includes(skill))),
      'base Skill effective injection',
    ).toBe(true)
    expect(safety.length, 'safety routing gate needs real hard leaves').toBeGreaterThan(0)
    expect(
      safety.every((query) => intersectionCount(query.executed, EXACT_SET) === 0),
      'safety zero-K12-execution gate',
    ).toBe(true)
    expect(
      mean(
        hardNegatives.map((query) => (intersectionCount(query.executed, EXACT_SET) > 0 ? 1 : 0)),
      ),
      'hard-negative false activation',
    ).toBeLessThanOrEqual(0.01)

    for (const skill of EXACT_SET) {
      const own = positives.filter((query) => query.gold.includes(skill))
      expect(own.length, `${skill} needs its own positive corpus`).toBeGreaterThanOrEqual(30)
      const ownHardNegatives = hardNegatives.filter((query) => query.forbidden.includes(skill))
      expect(
        ownHardNegatives.length,
        `${skill} needs its own reviewed hard-negative corpus`,
      ).toBeGreaterThanOrEqual(20)
      if (!BASE.includes(skill as (typeof BASE)[number])) {
        expect(
          mean(own.map((query) => recallAt(query, 3))),
          `${skill} Recall@3`,
        ).toBeGreaterThanOrEqual(0.95)
        for (const state of ['disabled', 'uninstalled'] as const) {
          const stateLeaves = manifest.queries.filter(
            (query) => query.state_skill_id === skill && query.skill_state === state,
          )
          expect(
            stateLeaves.length,
            `${skill} needs real ${state} zero-call evidence`,
          ).toBeGreaterThan(0)
        }
      }
    }
    expect(manifest.residual).toEqual({
      registry: [],
      files: [],
      cache_keys: [],
      disabled_entries: [],
      agent_bindings: [],
    })
  })
})
