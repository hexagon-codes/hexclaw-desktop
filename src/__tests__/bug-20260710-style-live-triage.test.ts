/**
 * BUG-20260710 · 装机 live 样式巡检三连（用户截图取证）+ 未定义 CSS 变量全局扫描。
 *
 * ① 智能体页：K12 场景卡的「删除」孤零零一行（扩展动作行之外又冒出一行通用 .hc-crow），
 *    与原型漂移——原型 app.html:1300 K12 卡动作行只有「进入辅导/错题本/编辑档案」，无删除。
 *    修复：场景卡不渲染通用删除行；删除作为低频动作下沉到「编辑档案」弹层（K12ProfileForm 编辑态）。
 * ② 错题本「⋯」溢出菜单：「导出 Markdown」折成两行——菜单项缺 white-space: nowrap。
 * ③ MCP 市场「已安装」按钮隐形：背景用了未定义 token `--hc-text-tertiary`（global.css 只有
 *    primary/secondary/muted/inverse）→ 透明底白字。横向扩散 4 个文件。
 *
 * ③ 的根治锁：扫描全部 src/**（.vue/.ts/.css）里引用的 --hc-* 变量，每一处都必须在
 *    global.css 有定义（或是本文件内自定义）。粒度=每个引用点，新增未定义 token 直接 FAIL。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import fs from 'node:fs'
import path from 'node:path'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '@/features/k12/i18n/zh-CN'
import K12ProfileForm from '@/features/k12/views/K12ProfileForm.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const SRC = path.resolve(__dirname, '..')

// ───────────────────────── ③ 未定义 CSS 变量全局扫描（粒度=每个引用点） ─────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|ts|css)$/.test(e.name) && !p.includes('__tests__')) out.push(p)
  }
  return out
}

describe('BUG-20260710 ③ · 全局 CSS 变量引用必须有定义（防隐形控件）', () => {
  it('src/** 引用的每个 --hc-* 变量都在 global.css 或本文件内有定义', () => {
    const globalCss = fs.readFileSync(path.join(SRC, 'assets/styles/global.css'), 'utf8')
    const defined = new Set([...globalCss.matchAll(/(--hc-[\w-]+)\s*:/g)].map((m) => m[1]))

    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const body = fs.readFileSync(file, 'utf8')
      // 本文件自定义的变量也算已定义（组件局部 token）
      const local = new Set([...body.matchAll(/(--hc-[\w-]+)\s*:/g)].map((m) => m[1]))
      // 只抓「无 fallback」的引用：var(--hc-x, #888) 自带兜底是安全的
      for (const m of body.matchAll(/var\(\s*(--hc-[\w-]+)\s*\)/g)) {
        const name = m[1]
        if (!defined.has(name) && !local.has(name)) {
          offenders.push(`${path.relative(SRC, file)} → ${name}`)
        }
      }
    }
    expect(
      offenders,
      `以下引用了未定义的 --hc-* 变量（会解析为空 → 隐形/错色控件）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ───────────────────────── ② 溢出菜单不折行 ─────────────────────────

describe('BUG-20260710 ② · 错题本溢出菜单项不折行', () => {
  it('.k12rec__menu 按钮样式声明 white-space: nowrap（「导出 Markdown」不得折成两行）', () => {
    const body = fs.readFileSync(
      path.join(SRC, 'features/k12/views/K12RecordsView.vue'),
      'utf8',
    )
    const menuBtnRule = body.match(/\.k12rec__menu button \{[^}]*\}/)?.[0] ?? ''
    expect(menuBtnRule, '.k12rec__menu button 规则应存在').not.toBe('')
    expect(menuBtnRule).toContain('white-space: nowrap')
  })
})

// ───────────────────────── ① 场景卡删除下沉到编辑档案弹层 ─────────────────────────

const h = vi.hoisted(() => ({
  unregisterSpy: vi.fn().mockResolvedValue({}),
  updateSpy: vi.fn().mockResolvedValue({}),
  profileSpy: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn().mockResolvedValue({}),
  updateAgent: (name: string, u: unknown) => h.updateSpy(name, u),
  unregisterAgent: (name: string) => h.unregisterSpy(name),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', () => ({
  k12UpdateProfile: (r: unknown) => h.profileSpy(r),
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
  k12TutorTurn: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(), k12TutoringTips: vi.fn(), k12Grade: vi.fn(),
  k12InsightReport: vi.fn(), k12StudyTime: vi.fn(), k12ListAccumulation: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('BUG-20260710 ① · K12 卡删除入口下沉', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    h.unregisterSpy.mockClear()
  })

  it('AgentsView：场景实例卡不再渲染通用「删除」孤行（对齐原型 K12 卡动作行）', () => {
    const body = fs.readFileSync(path.join(SRC, 'views/AgentsView.vue'), 'utf8')
    // 删除按钮的 v-if 必须排除场景卡（isScenarioAgent），否则 K12 卡下方多出孤行删除
    const deleteBtn = body.match(/<button[^>]*\n?[^>]*hc-btn--danger[\s\S]{0,200}?agents\.delete/)?.[0] ?? ''
    expect(deleteBtn, '通用删除按钮应存在').not.toBe('')
    expect(
      deleteBtn.includes('!isScenarioAgent(agent)'),
      '通用删除按钮 v-if 必须排除场景实例卡（删除下沉到编辑档案弹层）',
    ).toBe(true)
  })

  it('K12ProfileForm 编辑态：提供「删除档案」入口，确认后调 unregisterAgent 并 emit removed', async () => {
    const wrapper = mount(K12ProfileForm, {
      props: {
        agent: {
          name: 'k12-tutor-x', display_name: '小明的辅导助手 · 五年级',
          metadata: { scenario: 'k12', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版' },
        } as never,
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    // 表单 Teleport 到 body，需从 document 查询
    const openBtn = document.body.querySelector('[data-testid="k12pf-delete"]') as HTMLElement | null
    expect(!!openBtn, '编辑档案弹层应有「删除档案」低频动作入口').toBe(true)
    openBtn!.click()
    await flushPromises()

    // 公共 ConfirmDialog 自身已独立覆盖 5 秒冷却；这里只验证删除动作接线。
    const dialog = wrapper.findComponent(ConfirmDialog)
    expect(dialog.props('open'), '删除必须打开二次确认对话框').toBe(true)
    dialog.vm.$emit('confirm')
    await flushPromises()

    expect(h.unregisterSpy).toHaveBeenCalledWith('k12-tutor-x')
    expect(wrapper.emitted('removed'), '删除成功应通知父级刷新列表').toBeTruthy()
  })
})
