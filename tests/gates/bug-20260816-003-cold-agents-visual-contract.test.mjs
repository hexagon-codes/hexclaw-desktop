import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const legacyRunnerPath = path.join(repoRoot, 'tests/e2e/session-list-prototype-compare.mjs')
const runnerPath = path.join(
  repoRoot,
  'tests/e2e/bug-20260816-003-cold-agents-visual.spec.ts',
)
const configPath = path.join(
  repoRoot,
  'tests/e2e/bug-20260816-003-cold-agents.playwright.config.ts',
)

test('旧会话列表视觉脚本不能作为 agents 冷启动证据', async () => {
  const legacy = await readFile(legacyRunnerPath, 'utf8')
  assert.match(legacy, /agents:\s*\[\{\s*name:\s*AGENT/u)
  assert.doesNotMatch(legacy, /NOT_COMPARABLE/u)
  assert.doesNotMatch(legacy, /changed_pixel_ratio/u)
  assert.doesNotMatch(legacy, /agentsLoaded/u)
})

test('独立冷启动 runner 冻结 pending 与 empty 两态并输出视觉诊断证据', async () => {
  const [runner, config] = await Promise.all([
    readFile(runnerPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ])

  assert.match(runner, /agents-not-ready/u)
  assert.match(runner, /agents-empty/u)
  assert.match(runner, /agentEndpointState/u)
  assert.match(runner, /503/u)
  assert.match(runner, /agents:\s*\[\]/u)
  assert.match(runner, /hc-sessions__item--pinned/u)
  assert.match(runner, /toBeDisabled\(\)/u)
  assert.match(runner, /固定置顶/u)
  assert.match(runner, /orderAfter/u)
  assert.match(runner, /pixel-diff\.png/u)
  assert.match(runner, /bbox-computed-style\.json/u)
  assert.match(runner, /NOT_COMPARABLE/u)
  assert.match(runner, /stateEquivalence:\s*false/u)
  assert.match(runner, /fileURLToPath\(import\.meta\.url\)/u)
  assert.match(
    runner,
    /\.\.\/hexclaw-docs\/test\/evidence\/bug-20260816-003-cold-agents-current-source/u,
  )
  assert.doesNotMatch(runner, /test-results\/bug-20260816-003-cold-agents-source/u)

  assert.match(config, /strictPort/u)
  assert.match(config, /reuseExistingServer:\s*false/u)
  assert.match(config, /locale:\s*'zh-CN'/u)
  assert.match(config, /deviceScaleFactor:\s*1/u)
  assert.match(config, /colorScheme:\s*'light'/u)
  assert.doesNotMatch(config, /16060|16061|16070/u)
})
