/**
 * BUG PROOF (RED): i18n 缺键 → 英文/维语用户看到中文兜底文案。
 *
 * 新功能代码大量以 `t('<key>', '<中文兜底>')` 形式引用 i18n 键，但这些键在
 * 三份 locale 文件里都未定义。因为有第二参兜底，运行时不会崩；但
 * fallbackLocale='zh-CN' 且键全缺，en / ug-CN 用户实际看到的是硬编码中文。
 *
 * 下面列出的键全部来自真实 `t()` 调用点（grep 自 ConnectionsView / ConnectorConfigModal /
 * PromptsView / McpView / SkillsView / AgentsView）。本测试断言「每个 locale 都应定义这些键」，
 * 当前会 FAIL —— 失败即证明缺键 bug 存在。补齐三语言后转绿，即可作为回归护栏。
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

const LOCALES: Record<string, unknown> = { 'zh-CN': zhCN, en, 'ug-CN': ugCN }

/** 代码中被 t() 引用、却未在 locale 文件定义的键（dotted path）。 */
const KEYS_REFERENCED_IN_CODE = [
  // —— 数据连接器（ConnectionsView / ConnectorConfigModal）——
  'connections.connectors.emptyTitle',
  'connections.connectors.emptyDesc',
  'connections.connectors.testStub',
  'connections.connectors.authStub',
  'connections.connectors.authHint',
  'connections.connectors.authorize',
  'connections.connectors.newInstance',
  'connections.connectors.selectType',
  'connections.connectors.form.name',
  'connections.connectors.form.host',
  'connections.connectors.form.port',
  'connections.connectors.form.database',
  'connections.connectors.form.user',
  'connections.connectors.form.password',
  'connections.connectors.form.path',
  'connections.connectors.form.url',
  // —— Prompts / 记忆（PromptsView）——
  'prompts.editPrompt',
  'prompts.fCategoryPh',
  'prompts.fModelPh',
  'prompts.fScopePh',
  'memories.newMemory',
  'memories.editMemory',
  // —— MCP 市场（McpView）——
  'mcp.recommendedTitle',
  'mcp.oneClickInstall',
  'mcp.cat.all',
  'mcp.cat.dev',
  'mcp.cat.data',
  'mcp.cat.docs',
  'mcp.cat.search',
  'mcp.cat.browser',
  'mcp.cat.collab',
  'mcp.cat.finance',
  'mcp.cat.productivity',
  'mcp.cat.edu',
  'mcp.cat.media',
  'mcp.cat.utility',
  'mcp.rec.filesystem',
  'mcp.rec.github',
  'mcp.rec.githubOfficial',
  'mcp.rec.gitlab',
  'mcp.rec.git',
  'mcp.rec.postgres',
  'mcp.rec.sqlite',
  'mcp.rec.redis',
  'mcp.rec.slack',
  'mcp.rec.notion',
  'mcp.rec.obsidian',
  'mcp.rec.gdrive',
  'mcp.rec.gmaps',
  'mcp.rec.fetch',
  'mcp.rec.brave',
  'mcp.rec.ddg',
  'mcp.rec.puppeteer',
  'mcp.rec.playwright',
  'mcp.rec.memory',
  'mcp.rec.sequential',
  'mcp.rec.time',
  'mcp.rec.everything',
  'mcp.rec.sentry',
  'mcp.rec.excel',
  'mcp.rec.wikipedia',
  'mcp.rec.youtube',
  'mcp.rec.hfspace',
  'mcp.rec.awskb',
  'mcp.rec.awsLabs',
  'mcp.rec.tiger',
  'mcp.rec.futu',
  'mcp.rec.ths',
  'mcp.rec.dzh',
  'mcp.rec.eastmoney',
  // —— Skills 市场（SkillsView）——
  'skills.hub.recommendedTitle',
  'skills.hub.catEducation',
  'skills.hub.catMedia',
  'skills.hub.catLife',
  // —— Agents（AgentsView）——
  'agents.chooseStartTitle',
  'agents.startBlank',
  'agents.startBlankMeta',
  // —— 公共 ——
  'common.back',
]

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

describe('BUG: i18n keys referenced in feature code are absent → Chinese leaks to en/ug', () => {
  for (const [loc, messages] of Object.entries(LOCALES)) {
    it(`locale "${loc}" defines every key the new feature code calls via t()`, () => {
      const missing = KEYS_REFERENCED_IN_CODE.filter(
        (k) => typeof resolve(messages, k) !== 'string',
      )
      expect(
        missing,
        `locale "${loc}" is missing ${missing.length}/${KEYS_REFERENCED_IN_CODE.length} keys:\n  ${missing.join('\n  ')}`,
      ).toEqual([])
    })
  }
})
