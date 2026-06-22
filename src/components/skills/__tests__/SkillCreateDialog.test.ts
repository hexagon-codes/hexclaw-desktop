/**
 * SkillCreateDialog — 与 AI 对话创建 Skill 流程（P1.3）。
 * describe → generate → preview(可编辑) → save(install content)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import SkillCreateDialog from '../SkillCreateDialog.vue'

const generateSkill = vi.hoisted(() => vi.fn())
const installSkillContent = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('@/api/skills', () => ({ generateSkill, installSkillContent }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))

// 预览态会挂真实 MarkdownRenderer（含 shiki 异步），组件测试只关心「内容是否交给预览组件」，故 stub。
const SkillMarkdownPreviewStub = {
  name: 'SkillMarkdownPreview',
  props: ['content', 'showFrontmatter', 'allowRawToggle'],
  template: '<div class="smp-stub">{{ content }}</div>',
}

function mountDialog() {
  return mount(SkillCreateDialog, {
    props: { visible: true },
    attachTo: document.body,
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
      stubs: { teleport: true, SkillMarkdownPreview: SkillMarkdownPreviewStub },
    },
  })
}

describe('SkillCreateDialog', () => {
  beforeEach(() => {
    generateSkill.mockReset()
    installSkillContent.mockReset()
    toast.success.mockReset()
  })

  it('描述→生成→预览→保存安装的完整闭环', async () => {
    generateSkill.mockResolvedValue('---\nname: notes\nicon: 📝\n---\n# Notes')
    installSkillContent.mockResolvedValue({ name: 'notes', message: 'ok' })

    const w = mountDialog()
    await w.find('textarea').setValue('整理会议纪要')
    // 生成按钮（描述步）
    const genBtn = w.findAll('button').find((b) => b.text().includes('生成'))!
    await genBtn.trigger('click')
    await flushPromises()

    expect(generateSkill).toHaveBeenCalledWith('整理会议纪要')
    // 进入预览步：编辑区出现生成内容
    const preview = w.find('textarea')
    expect((preview.element as HTMLTextAreaElement).value).toContain('name: notes')

    // 保存
    const saveBtn = w.findAll('button').find((b) => b.text().includes('保存'))!
    await saveBtn.trigger('click')
    await flushPromises()

    expect(installSkillContent).toHaveBeenCalledWith('---\nname: notes\nicon: 📝\n---\n# Notes')
    expect(toast.success).toHaveBeenCalled()
    expect(w.emitted('created')?.[0]).toEqual(['notes'])
    expect(w.emitted('close')).toBeTruthy()
  })

  it('生成失败显示错误，不进入预览', async () => {
    generateSkill.mockRejectedValue(new Error('上游超时'))
    const w = mountDialog()
    await w.find('textarea').setValue('x')
    await w.findAll('button').find((b) => b.text().includes('生成'))!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('上游超时')
    expect(installSkillContent).not.toHaveBeenCalled()
  })

  it('描述为空时不触发生成', async () => {
    const w = mountDialog()
    const genBtn = w.findAll('button').find((b) => b.text().includes('生成'))!
    await genBtn.trigger('click')
    await flushPromises()
    expect(generateSkill).not.toHaveBeenCalled()
  })

  it('Step2 编辑/预览 Tab：默认编辑态，切预览态把当前内容交给 SkillMarkdownPreview', async () => {
    generateSkill.mockResolvedValue('---\nname: notes\n---\n# Notes')
    const w = mountDialog()
    await w.find('textarea').setValue('整理会议纪要')
    await w.findAll('button').find((b) => b.text().includes('生成'))!.trigger('click')
    await flushPromises()

    // 默认编辑态：有可编辑 textarea，无预览组件
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.findComponent(SkillMarkdownPreviewStub).exists()).toBe(false)

    // 切到预览：textarea 消失，预览组件拿到当前 content（含 frontmatter，由组件内部剥离）
    const previewBtn = w.findAll('button').find((b) => b.text().trim() === '预览')!
    await previewBtn.trigger('click')
    expect(w.find('textarea').exists()).toBe(false)
    const smp = w.findComponent(SkillMarkdownPreviewStub)
    expect(smp.exists()).toBe(true)
    expect(smp.props('content')).toContain('name: notes')
    expect(smp.props('showFrontmatter')).toBe(true)
    expect(smp.props('allowRawToggle')).toBe(false)
  })

  it('Step2 按反馈重新生成：组合 prompt 调 generate，更新草稿并切到预览', async () => {
    generateSkill.mockResolvedValueOnce('---\nname: notes\n---\n# Notes')
    const w = mountDialog()
    await w.find('textarea').setValue('整理会议纪要')
    await w.findAll('button').find((b) => b.text().includes('生成'))!.trigger('click')
    await flushPromises()
    expect(generateSkill).toHaveBeenCalledTimes(1)

    // refine：第二次生成返回新内容
    generateSkill.mockResolvedValueOnce('---\nname: notes\ndescription: better\n---\n# Notes v2')
    await w.find('input').setValue('增加错误处理步骤')
    await w.findAll('button').find((b) => b.text().includes('重新生成'))!.trigger('click')
    await flushPromises()

    expect(generateSkill).toHaveBeenCalledTimes(2)
    const prompt = generateSkill.mock.calls[1]![0] as string
    expect(prompt).toContain('增加错误处理步骤') // 反馈要求
    expect(prompt).toContain('# Notes') // 现有草稿被带上
    // 自动切到预览态，预览组件拿到新内容
    const smp = w.findComponent(SkillMarkdownPreviewStub)
    expect(smp.exists()).toBe(true)
    expect(smp.props('content')).toContain('# Notes v2')
    // 不应误触发安装
    expect(installSkillContent).not.toHaveBeenCalled()
  })
})
