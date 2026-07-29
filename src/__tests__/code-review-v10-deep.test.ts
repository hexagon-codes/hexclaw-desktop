/**
 * Code Review v10 — Deep Static Analysis Tests
 *
 * Reads source files and verifies bugs we found and fixed,
 * plus documents remaining issues. Each test reads the actual source
 * and asserts the current (correct or documented) behavior.
 *
 * Categories:
 *   1. ToolApprovalCard timer cleanup (FIXED)
 *   2. CanvasView drag-then-click edge prevention (FIXED)
 *   3. Canvas store self-loop prevention (FIXED)
 *   4. Canvas store runWorkflow backend failure (FIXED)
 *   5. BudgetPanel division by zero (FIXED)
 *   6. LogsView i18n (FIXED)
 *   7. DashboardView dashTab dead code (DOCUMENTED)
 *   9. SettingsSecurity ARIA attribute (DOCUMENTED)
 *  10. ChatExportMenu filename sanitization (DOCUMENTED)
 *  11. ErrorBoundary uses Tailwind instead of BEM (DOCUMENTED)
 *  12. TemplatePopup potential issues (DOCUMENTED)
 *  13. MentionPopup hardcoded limit (DOCUMENTED)
 *  14. CommandPalette theme toggle (DOCUMENTED)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')

function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

// ════════════════════════════════════════════════════════════
// 1. ToolApprovalCard timer cleanup (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #1: ToolApprovalCard timer cleanup', () => {
  const src = readSrc('components/chat/ToolApprovalCard.vue')

  it('imports onUnmounted from vue', () => {
    expect(src).toMatch(/import\s*\{[^}]*onUnmounted[^}]*\}\s*from\s*['"]vue['"]/)
  })

  it('calls clearInterval(timer) inside onUnmounted', () => {
    expect(src).toContain('onUnmounted(() => clearInterval(timer))')
  })

  it('uses setInterval to create countdown timer', () => {
    expect(src).toMatch(/const\s+timer\s*=\s*setInterval\(/)
  })

  it('clears timer on approve action', () => {
    // Verify approve function also clears timer to prevent leak
    const approveBlock = src.slice(src.indexOf('function approve()'))
    expect(approveBlock).toContain('clearInterval(timer)')
  })

  it('clears timer on deny action', () => {
    const denyBlock = src.slice(src.indexOf('function deny()'))
    expect(denyBlock).toContain('clearInterval(timer)')
  })
})

// ════════════════════════════════════════════════════════════
// 2. CanvasView drag-then-click edge prevention (FIXED)
// ════════════════════════════════════════════════════════════

// Issue #2 CanvasView：整页已于 2026-06-22 删除（路由双重定向走 + 零引用，被 WorkflowPanel 取代）。
// 对应 stopDrag 扫描测试随之移除。回归锁见 audit-v2-ui-closure-20260622.test.ts（UI-4）。

// ════════════════════════════════════════════════════════════
// 3. Canvas store self-loop prevention (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #3: Canvas store self-loop prevention', () => {
  const src = readSrc('stores/canvas.ts')

  it('addEdge guards against self-loops with from === to check', () => {
    expect(src).toContain('edge.from === edge.to')
  })

  it('addEdge returns early for self-loop edges', () => {
    // The self-loop guard should cause an early return
    const addEdgeStart = src.indexOf('function addEdge(')
    const addEdgeSection = src.slice(addEdgeStart, addEdgeStart + 200)
    expect(addEdgeSection).toMatch(/if\s*\(edge\.from\s*===\s*edge\.to\)\s*return/)
  })

  it('addEdge also checks for duplicate edges', () => {
    const addEdgeStart = src.indexOf('function addEdge(')
    const addEdgeSection = src.slice(addEdgeStart, addEdgeStart + 300)
    expect(addEdgeSection).toContain('e.from === edge.from && e.to === edge.to')
  })
})

// ════════════════════════════════════════════════════════════
// 4. Canvas store runWorkflow backend failure (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #4: Canvas store runWorkflow marks nodes as failed on backend error', () => {
  const src = readSrc('stores/canvas.ts')

  it('else branch marks nodes as failed not completed', () => {
    // The else branch (backend unavailable) should mark all nodes as 'failed'
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(runWorkflowBody.indexOf('} else {'))
    expect(elseBranch).toContain("'failed'")
  })

  it('else branch sets runStatus to failed', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(runWorkflowBody.indexOf('} else {'))
    expect(elseBranch).toContain("runStatus.value = 'failed'")
  })

  it('else branch does NOT mark nodes as completed', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(
      runWorkflowBody.indexOf('} else {'),
      runWorkflowBody.indexOf('} else {') + 400,
    )
    // The else branch should not contain 'completed' for node status
    expect(elseBranch).not.toMatch(/\[nid\]:\s*'completed'/)
  })

  it('success branch marks nodes as completed with animation', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    // Between if (res) { and } else {
    const successBranch = runWorkflowBody.slice(
      runWorkflowBody.indexOf('if (res)'),
      runWorkflowBody.indexOf('} else {'),
    )
    expect(successBranch).toContain("'completed'")
    expect(successBranch).toContain("'running'")
  })
})

// ════════════════════════════════════════════════════════════
// 5. BudgetPanel division by zero (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #5: BudgetPanel division by zero guard', () => {
  const src = readSrc('components/chat/BudgetPanel.vue')

  it('tokenPct uses maxTokens > 0 guard', () => {
    expect(src).toMatch(/tokenPct.*props\.maxTokens\s*>\s*0/)
  })

  it('tokenPct returns 0 when maxTokens is 0', () => {
    // The ternary should return 0 for the falsy case
    expect(src).toMatch(/tokenPct.*props\.maxTokens\s*>\s*0\s*\?.*:\s*0/)
  })

  it('costPct uses maxCost > 0 guard', () => {
    expect(src).toMatch(/costPct.*props\.maxCost\s*>\s*0/)
  })

  it('costPct returns 0 when maxCost is 0', () => {
    expect(src).toMatch(/costPct.*props\.maxCost\s*>\s*0\s*\?.*:\s*0/)
  })

  it('durationPct also has division guard', () => {
    expect(src).toMatch(/durationPct.*maxDurSeconds\.value\s*>\s*0/)
  })
})

// ════════════════════════════════════════════════════════════
// 6. LogsView i18n (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #6: LogsView i18n — no hardcoded Chinese strings', () => {
  const src = readSrc('views/LogsView.vue')
  const enLocale = readSrc('i18n/locales/en.ts')
  const zhLocale = readSrc('i18n/locales/zh-CN.ts')

  it('does NOT contain hardcoded "刚刚" string', () => {
    expect(src).not.toContain("'刚刚'")
    expect(src).not.toContain('"刚刚"')
  })

  it('uses locale-neutral absolute time (formatLogTime), no relative-time strings to translate', () => {
    // P0 重构：相对时间（每秒刷新）改为绝对时间 HH:MM:SS.mmm —— 与语言无关、无中文、去掉 1Hz 全量重渲
    expect(src).toContain('formatLogTime')
    expect(src).toContain("from '@/utils/time'")
    expect(src).not.toContain('formatRelativeTime')
    expect(src).not.toContain('setInterval')
  })

  it('en.ts has logs.justNow key', () => {
    expect(enLocale).toMatch(/justNow:\s*['"]/)
  })

  it('zh-CN.ts has logs.justNow key', () => {
    expect(zhLocale).toMatch(/justNow:\s*['"]/)
  })

  it('renders row timestamps via formatLogTime (absolute, no 1Hz now.value timer)', () => {
    // \u65f6\u95f4\u6233\u76f4\u63a5 formatLogTime(entry.timestamp) \u6e32\u67d3\uff0c\u65e0 now.value \u5b9a\u65f6\u5668\uff08\u907f\u514d\u6bcf\u79d2\u6574\u5217\u91cd\u6e32\uff09
    expect(src).toContain('formatLogTime(entry.timestamp)')
    expect(src).not.toContain('now.value')
  })
})

// ════════════════════════════════════════════════════════════
// 9. SettingsSecurity ARIA attribute (DOCUMENTED)
// ════════════════════════════════════════════════════════════

// Issue #9 SettingsSecurity：组件已于 2026-06-22 作为孤儿死代码删除（10 toggle UI 不可达）。
// 对应 aria 扫描测试随之移除。回归锁见 audit-v2-ui-closure-20260622.test.ts（UI-1/2）。

// ════════════════════════════════════════════════════════════
// 10. ChatExportMenu filename sanitization (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #10 [DOCUMENTED]: ChatExportMenu filename lacks sanitization', () => {
  const src = readSrc('components/chat/ChatExportMenu.vue')

  it('uses sessionTitle directly in filename for Markdown export', () => {
    expect(src).toMatch(/download\(md,\s*`\$\{title\}\.md`/)
  })

  it('uses sessionTitle directly in filename for JSON export', () => {
    expect(src).toMatch(/download\(JSON\.stringify.*`\$\{title\}\.json`/)
  })

  it('[SMELL] title comes from sessionTitle without sanitization', () => {
    // title is set from props.sessionTitle which can contain special chars
    expect(src).toContain('const title = props.sessionTitle || t(')
  })

  it('[SMELL] no replace/sanitize call exists for filename characters', () => {
    // The download function does not sanitize the filename param
    const downloadFn = src.slice(src.indexOf('function download('))
    expect(downloadFn).not.toMatch(/\.replace\(/)
    expect(downloadFn).not.toMatch(/sanitize/)
  })
})

// ════════════════════════════════════════════════════════════
// 11. ErrorBoundary uses Tailwind instead of BEM (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #11 [DOCUMENTED]: ErrorBoundary uses Tailwind utility classes instead of BEM', () => {
  const src = readSrc('components/common/ErrorBoundary.vue')

  it('uses Tailwind "flex" class', () => {
    expect(src).toContain('class="h-full flex items-center justify-center p-8"')
  })

  it('uses Tailwind "text-center" class', () => {
    expect(src).toContain('class="text-center max-w-sm"')
  })

  it('uses Tailwind "mx-auto" and "mb-4" classes', () => {
    expect(src).toContain('mx-auto mb-4')
  })

  it('uses Tailwind utility classes on the retry button', () => {
    expect(src).toMatch(/class="inline-flex items-center gap-1\.5 px-4 py-2 rounded-lg/)
  })

  it('[SMELL] does NOT use any hc- BEM class names', () => {
    // ErrorBoundary template has no hc-* prefixed class names
    const templateStart = src.indexOf('<template>')
    const templateEnd = src.indexOf('</template>')
    const template = src.slice(templateStart, templateEnd)
    expect(template).not.toMatch(/class="[^"]*hc-/)
  })
})

// ════════════════════════════════════════════════════════════
// 12. TemplatePopup potential issues (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #12 [DOCUMENTED]: TemplatePopup .catch() on synchronous function and search overlap', () => {
  const src = readSrc('components/chat/TemplatePopup.vue')

  it('dbTemplateIncrementUse is declared as returning void (synchronous)', () => {
    expect(src).toMatch(/function\s+dbTemplateIncrementUse\([^)]*\):\s*void/)
  })

  it('[FIXED] handleSelect calls dbTemplateIncrementUse without .catch()', () => {
    // 统一命令面板重构后入参为 PaletteItem（item.id）；仍是同步调用，无 .catch。
    expect(src).toContain('dbTemplateIncrementUse(item.id)')
    expect(src).not.toMatch(/dbTemplateIncrementUse\([^)]*\)\.catch/)
  })

  it('watch on query reloads via reload()→loadMerged (server prompts + local templates)', () => {
    // query 变化时经 reload() → loadMerged 合并服务端 Prompt 库 + 本地模板（内部仍调 dbSearchTemplates）。
    const queryWatch = src.slice(src.indexOf("watch(() => props.query"))
    expect(queryWatch).toContain('reload(q)')
    expect(src).toContain('loadMerged(query)') // reload 内部合并服务端 + 本地
    expect(src).toContain('dbSearchTemplates') // 本地过滤仍在 loadMerged 内部
  })

  it('client-side filtering lives in promptItems/skillItems computeds (not inline in filtered)', () => {
    // 重构后 filtered = [...skillItems, ...promptItems]，过滤下沉到各自 computed，更清晰。
    expect(src).toMatch(/const\s+filtered\s*=\s*computed/)
    const promptItems = src.slice(src.indexOf('const promptItems = computed'))
    expect(promptItems).toContain('tpl.title.toLowerCase().includes(q)')
  })

  it('[SMELL] query change still triggers both server reload and client-side filter', () => {
    // watch reload (loadMerged → 服务端 + 本地) on query change
    const watchBlock = src.slice(src.indexOf("watch(() => props.query"))
    expect(watchBlock).toContain('reload')
    // promptItems computed 仍按 query 客户端过滤（服务端已按 query 拉取 → 仍有冗余，保留文档）
    const promptItemsBlock = src.slice(src.indexOf('const promptItems = computed'), src.indexOf('const promptItems = computed') + 400)
    expect(promptItemsBlock).toContain('props.query.toLowerCase()')
  })
})

// ════════════════════════════════════════════════════════════
// 13. MentionPopup hardcoded limit (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('MentionPopup 分栏多实体上下文召唤（2026-06-22 升级）', () => {
  const src = readSrc('components/chat/MentionPopup.vue')

  it('支持 Agent + 知识 + 连接 + 会话 四类实体', () => {
    expect(src).toContain("'agent'")
    expect(src).toContain("'knowledge'")
    expect(src).toContain("'connection'")
    expect(src).toContain("'session'")
  })

  it('采用分栏 tab（全部/各实体）而非单一扁平列表', () => {
    expect(src).toContain('activeTab')
    expect(src).toContain('hc-mention__tabs')
  })

  it('按分类做条数限制（每类上限，避免单类刷屏）', () => {
    expect(src).toMatch(/\.slice\(0,\s*\d+\)/)
  })

  it('不含 member 实体类型（单用户本地工作站定位，无多用户协作）', () => {
    expect(src).not.toContain("'member'")
    expect(src).not.toMatch(/type:\s*'member'/)
  })
})

// ════════════════════════════════════════════════════════════
// 14. CommandPalette theme toggle (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #14 [DOCUMENTED]: CommandPalette theme toggle only handles dark/light', () => {
  const src = readSrc('components/common/CommandPalette.vue')

  it('toggleTheme reads data-theme attribute', () => {
    expect(src).toContain("root.getAttribute('data-theme')")
  })

  it('toggleTheme only checks for dark to toggle to light', () => {
    expect(src).toContain("current === 'dark' ? 'light' : 'dark'")
  })

  it('[SMELL] toggleTheme does not handle system/auto theme preference', () => {
    const toggleFn = src.slice(src.indexOf('function toggleTheme()'), src.indexOf('function toggleTheme()') + 300)
    expect(toggleFn).not.toContain('matchMedia')
    expect(toggleFn).not.toContain('system')
    expect(toggleFn).not.toContain('auto')
  })

  it('[SMELL] any non-dark value (null, "system", etc.) maps to dark', () => {
    // If data-theme is null or "system", the ternary treats it as non-dark -> sets to dark
    const toggleFn = src.slice(src.indexOf('function toggleTheme()'), src.indexOf('function toggleTheme()') + 300)
    // Only two possible outcomes: 'light' or 'dark'
    const outcomes = toggleFn.match(/setAttribute\('data-theme',\s*current === 'dark' \? 'light' : 'dark'\)/)
    expect(outcomes).not.toBeNull()
  })
})
