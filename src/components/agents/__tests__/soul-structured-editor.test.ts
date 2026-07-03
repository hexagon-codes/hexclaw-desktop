/**
 * SOUL 结构化编辑器组件（原型 C 方案落地）：种子继承 / 段编辑 / 体检联动 / 完成回填。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import SoulStructuredEditor from '../SoulStructuredEditor.vue'

vi.mock('@/components/chat/MarkdownRenderer.vue', () => ({
  // runtime-only 构建下对象组件不能用 template 字符串 → render 函数替身
  default: { props: ['content'], render: () => null },
}))

function mountEditor(modelValue = '') {
  return mount(SoulStructuredEditor, {
    props: { modelValue, agentName: '测试体', skills: ['math-tutor'] },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })],
    },
  })
}

describe('SoulStructuredEditor', () => {
  it('已有人设文本作为 identity 种子；完整预设为底（7 段开启）', async () => {
    const w = mountEditor('你是专业翻译官。')
    await flushPromises()
    const identity = w.find('[data-testid="soul-seg-input-identity"]')
    expect((identity.element as HTMLTextAreaElement).value).toBe('你是专业翻译官。')
    expect(w.findAll('[data-testid^="soul-seg-input-"]').length).toBe(7)
  })

  it('体检分随段内容实时联动；预设切换重置状态', async () => {
    const w = mountEditor('')
    await flushPromises()
    const scoreOf = () => Number(w.find('[data-testid="soul-health-score"]').text())
    const fullScore = scoreOf()
    expect(fullScore).toBeGreaterThanOrEqual(80)

    await w.find('[data-testid="soul-preset-blank"]').trigger('click')
    expect(scoreOf()).toBeLessThan(fullScore)
  })

  it('完成并回填：只合成开启且非空段，emit apply 后 close', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-preset-blank"]').trigger('click')
    await w.find('[data-testid="soul-seg-toggle-identity"]').trigger('click') // 开启并自动填示例
    await w.find('[data-testid="soul-seg-input-identity"]').setValue('你是小蟹，靠谱的桌面助理。')
    await w.find('[data-testid="soul-apply"]').trigger('click')

    const applied = w.emitted('apply')
    expect(applied, '应 emit apply').toBeTruthy()
    expect(applied![0]![0]).toBe('## 身份（Identity）\n你是小蟹，靠谱的桌面助理。')
  })

  it('自动注入段展示真实挂载 Skill（只读）', async () => {
    const w = mountEditor('')
    await flushPromises()
    expect(w.text()).toContain('math-tutor')
    expect(w.text()).toContain('自动注入')
  })

  // BUG-20260704：左栏是 flex-col 滚动容器，段卡带 overflow-hidden（flex 子项
  // min-height 归零）——缺 flex:none 时内容超高会把所有卡片压扁裁剪（textarea 缩成
  // 一条缝，实机表现为"编辑不了"），而不是出滚动条。原型 .sec/.sec-auto 均为
  // flex:none，此处钉住结构契约：滚动列每个直接子元素都必须 flex-shrink-0。
  it('左栏滚动列直接子项全部 flex-shrink-0（防压扁裁剪）', async () => {
    const w = mountEditor('你是专业翻译官。')
    await flushPromises()
    const column = w.find('[data-testid="soul-seg-column"]')
    expect(column.exists(), '滚动列应有 soul-seg-column testid').toBe(true)
    const children = Array.from(column.element.children)
    expect(children.length).toBeGreaterThan(7)
    for (const el of children) {
      expect(
        el.classList.contains('flex-shrink-0'),
        `滚动列子项 <${el.tagName.toLowerCase()} class="${el.className}"> 缺 flex-shrink-0`,
      ).toBe(true)
    }
  })

  // ── 更多真实交互场景（对齐 Playwright 真实点击链路，component 层确定性覆盖）──

  const onSegs = (w: ReturnType<typeof mountEditor>) =>
    w.findAll('[data-testid^="soul-seg-toggle-"]')
      .filter((b) => b.attributes('aria-checked') === 'true')
      .map((b) => b.attributes('data-testid')!.replace('soul-seg-toggle-', ''))

  it('三预设切换：空白全关（仅基础分 12）/极简开 3 段 / 完整开 7 段', async () => {
    const w = mountEditor('')
    await flushPromises()

    await w.find('[data-testid="soul-preset-blank"]').trigger('click')
    expect(onSegs(w)).toEqual([])
    expect(Number(w.find('[data-testid="soul-health-score"]').text())).toBe(12)
    expect(w.findAll('[data-testid^="soul-seg-input-"]').length).toBe(0)

    await w.find('[data-testid="soul-preset-lite"]').trigger('click')
    expect(onSegs(w).sort()).toEqual(['constraints', 'identity', 'mission'])

    await w.find('[data-testid="soul-preset-full"]').trigger('click')
    expect(onSegs(w).length).toBe(7)
  })

  it('切预设丢弃手改（空白后重开完整回到示例底稿，不残留旧编辑）', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-seg-input-identity"]').setValue('自定义身份 XYZ')
    await w.find('[data-testid="soul-preset-blank"]').trigger('click')
    await w.find('[data-testid="soul-preset-full"]').trigger('click')
    const val = (w.find('[data-testid="soul-seg-input-identity"]').element as HTMLTextAreaElement).value
    expect(val).not.toContain('自定义身份 XYZ')
    expect(val.length).toBeGreaterThan(0)
  })

  it('关段隐藏输入框、体检扣分；重新开启自动回填示例', async () => {
    const w = mountEditor('')
    await flushPromises()
    const full = Number(w.find('[data-testid="soul-health-score"]').text())

    await w.find('[data-testid="soul-seg-toggle-mission"]').trigger('click') // 关
    expect(w.find('[data-testid="soul-seg-input-mission"]').exists()).toBe(false)
    expect(Number(w.find('[data-testid="soul-health-score"]').text())).toBeLessThan(full)

    await w.find('[data-testid="soul-seg-toggle-mission"]').trigger('click') // 再开
    const mission = w.find('[data-testid="soul-seg-input-mission"]')
    expect(mission.exists()).toBe(true)
    expect((mission.element as HTMLTextAreaElement).value.length).toBeGreaterThan(0)
  })

  it('「用示例」按钮覆盖当前内容为该段示例文本', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-seg-input-constraints"]').setValue('随便写点')
    await w.find('[data-testid="soul-seg-fill-constraints"]').trigger('click')
    const val = (w.find('[data-testid="soul-seg-input-constraints"]').element as HTMLTextAreaElement).value
    expect(val).not.toBe('随便写点')
    expect(val).toContain('二次确认')
  })

  it('原文/渲染预览切换：原文页出 <pre> 且含 markdown 小节标题', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-preview-raw-tab"]').trigger('click')
    const body = w.find('[data-testid="soul-preview-body"]')
    const pre = body.find('pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('## 身份（Identity）')
    expect(pre.text()).toContain('## 约束（Constraints）')
  })

  it('合成按段定义顺序拼接多小节（identity 在 constraints 之前）', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-apply"]').trigger('click')
    const text = w.emitted('apply')![0]![0] as string
    expect(text.indexOf('## 身份（Identity）')).toBeLessThan(text.indexOf('## 约束（Constraints）'))
  })

  // close() 的 emit('close') 走 300ms setTimeout（FLIP 收回动画），故用真实等待跨过。
  const waitClose = () => new Promise((r) => setTimeout(r, 320))

  it('全关（空白预设）时完成不产出人设：不 emit apply，仅 close', async () => {
    const w = mountEditor('')
    await flushPromises()
    await w.find('[data-testid="soul-preset-blank"]').trigger('click')
    await w.find('[data-testid="soul-apply"]').trigger('click')
    await waitClose()
    expect(w.emitted('apply')).toBeFalsy()
    expect(w.emitted('close')).toBeTruthy()
  })

  it('取消（点关闭）不回填：不 emit apply', async () => {
    const w = mountEditor('你是小蟹。')
    await flushPromises()
    // 底部「取消」按钮走 close(false)
    const cancelBtn = w.findAll('button').find((b) => b.text() === '取消')
    expect(cancelBtn, '应有取消按钮').toBeTruthy()
    await cancelBtn!.trigger('click')
    await waitClose()
    expect(w.emitted('apply')).toBeFalsy()
    expect(w.emitted('close')).toBeTruthy()
  })

  it('自动注入段只读（无可编辑输入框，仅展示 Skill chip）', async () => {
    const w = mountEditor('')
    await flushPromises()
    // 7 个自由段各一个 textarea；自动注入段不得再引入输入框
    expect(w.findAll('textarea').length).toBe(7)
    expect(w.text()).toContain('装配期实时拼接')
  })
})
