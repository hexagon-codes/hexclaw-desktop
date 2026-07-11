/**
 * AUDIT (RED→GREEN): 生产在用但三语 locale 全缺的 i18n key 护栏。
 *
 * 这批 key 全部来自真实 `t('<key>', '<中文兜底>')` / `t('<key>', {..}, '<兜底>')` 调用点
 * （grep 自 ModelManagerModal / SettingsView / ContextBar / WelcomeView / PromptsView /
 * ChatView / IntegrationView / AgentsView / AboutView / McpView / TasksView 等）。
 * 补齐前：三份 locale 均未定义 → en / ug-CN 用户因 fallbackLocale='zh-CN' 看到硬编码中文。
 *
 * 本测试对每个 locale 逐个断言 key 能从 messages 对象解析到非空字符串（不是只 check 文件含字符串）。
 * 补齐前 FAIL（缺键），补齐后 GREEN，作为三语平价回归护栏。
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

const LOCALES: Record<string, unknown> = { 'zh-CN': zhCN, en, 'ug-CN': ugCN }

/** 生产代码 t() 引用、须在三语 locale 全部定义的 key（dotted path）。 */
const KEYS = [
  // —— 上下文栏 ContextBar ——
  'contextbar.agentTip',
  'contextbar.engineOffline',
  'contextbar.engineOnline',
  'contextbar.engineRestarting',
  'contextbar.noAgent',
  'contextbar.noModel',
  'contextbar.providerModelTip',
  'contextbar.restarting',
  // —— 模型管理弹窗 ModelManagerModal ——
  'settings.modelManager.allVendors',
  'settings.modelManager.badgeFree',
  'settings.modelManager.badgeTools',
  'settings.modelManager.badgeVision',
  'settings.modelManager.clear',
  'settings.modelManager.clearConfirm',
  'settings.modelManager.deselectGroup',
  'settings.modelManager.empty',
  'settings.modelManager.enabledSummary',
  'settings.modelManager.enabledUnit',
  'settings.modelManager.filterCtx',
  'settings.modelManager.filterFree',
  'settings.modelManager.filterLabel',
  'settings.modelManager.filterTools',
  'settings.modelManager.filterVision',
  'settings.modelManager.leanHint',
  'settings.modelManager.newCount',
  'settings.modelManager.newTag',
  'settings.modelManager.otherVendor',
  'settings.modelManager.recommendDismiss',
  'settings.modelManager.recommendEnable',
  'settings.modelManager.recommendText',
  'settings.modelManager.resync',
  'settings.modelManager.searchPlaceholder',
  'settings.modelManager.selectGroup',
  'settings.modelManager.title',
  'settings.modelManager.vendorSearch',
  'settings.modelManager.viewAll',
  'settings.modelManager.viewEnabled',
  'settings.modelManager.viewNew',
  // —— 设置 · LLM（SettingsView）——
  'settings.llm.justSynced',
  'settings.llm.manageModels',
  'settings.llm.modelFreeLabel',
  'settings.llm.modelsAvailable',
  'settings.llm.modelsDynamic',
  'settings.llm.modelsEnabledSummary',
  'settings.llm.modelStale',
  'settings.llm.modelStaleLabel',
  'settings.llm.newModelsFound',
  // —— 设置 · 工具栏 ——
  'settings.toolbar.saveFailed',
  // —— 欢迎/引导 WelcomeView ——
  'welcome.ollamaDetecting',
  'welcome.ollamaHint',
  'welcome.ollamaNoModels',
  'welcome.ollamaNotRunning',
  'welcome.ollamaReady',
  'welcome.ollamaSelectModel',
  'welcome.quickAutomation',
  'welcome.quickAutomationDesc',
  'welcome.quickChannels',
  'welcome.quickChannelsDesc',
  // —— Prompt 库 PromptsView ——
  'prompts.deleteFailed',
  'prompts.mdHint',
  'prompts.newPrompt',
  'prompts.previewEmpty',
  'prompts.previewNote',
  'prompts.saveFailed',
  'prompts.tabEdit',
  'prompts.tabPreview',
  // —— 会话 ChatView ——
  'chat.orphanAgentCleared',
  'chat.persistFailed',
  // —— 集成搜索 IntegrationView ——
  'integration.searchMcp',
  'integration.searchPrompts',
  'integration.searchSkills',
  // —— 智能体 AgentsView ——
  'agents.systemPrompt',
  'agents.systemPromptPlaceholder',
  // —— 关于 AboutView ——
  'about.capLocalInference',
  // —— 公共 ——
  'common.noResults',
  // —— IM 通道绑定 ——
  'imChannels.bindFailed',
  // —— MCP ——
  'mcp.needsConfig',
  // —— 定时任务 ——
  'tasks.statusTimeout',
]

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

describe('AUDIT 20260711: production t() keys must exist in all three locales', () => {
  for (const [loc, messages] of Object.entries(LOCALES)) {
    it(`locale "${loc}" defines every audited key as a non-empty string`, () => {
      const missing = KEYS.filter((k) => {
        const v = resolve(messages, k)
        return typeof v !== 'string' || v.length === 0
      })
      expect(
        missing,
        `locale "${loc}" is missing ${missing.length}/${KEYS.length} keys:\n  ${missing.join('\n  ')}`,
      ).toEqual([])
    })
  }

  it('all three locales share the identical set of these keys (三语平价)', () => {
    for (const k of KEYS) {
      const zh = typeof resolve(zhCN, k) === 'string'
      const enOk = typeof resolve(en, k) === 'string'
      const ug = typeof resolve(ugCN, k) === 'string'
      expect(zh === enOk && enOk === ug, `key "${k}" parity zh=${zh} en=${enOk} ug=${ug}`).toBe(true)
    }
  })
})
