/**
 * SkillMarkdownPreview —— P0（frontmatter 不进渲染管道）+ 源码/预览切换 + 复制 + 空态 + frontmatter 校验。
 * 用 MarkdownRenderer stub 截获 content prop，精确断言「喂给渲染器的只有正文」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import SkillMarkdownPreview from '../SkillMarkdownPreview.vue'

const setClipboard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/api/desktop', () => ({ setClipboard }))

const MdStub = {
  name: 'MarkdownRenderer',
  props: ['content'],
  template: '<div class="md-stub">{{ content }}</div>',
}

const SAMPLE = [
  '---',
  'name: notes',
  'description: turn notes into actions',
  'icon: 📝',
  'triggers: [review, audit]',
  'tags:',
  '  - productivity',
  '---',
  '# Notes',
  '',
  'Body paragraph.',
].join('\n')

function mountPreview(props: Record<string, unknown>) {
  return mount(SkillMarkdownPreview, {
    props: props as never,
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { MarkdownRenderer: MdStub },
    },
  })
}

describe('SkillMarkdownPreview', () => {
  beforeEach(() => setClipboard.mockClear())

  it('P0：frontmatter 被剥离，只有正文进入 MarkdownRenderer', () => {
    const w = mountPreview({ content: SAMPLE })
    const md = w.findComponent(MdStub)
    expect(md.exists()).toBe(true)
    const passed = md.props('content') as string
    expect(passed).toContain('# Notes')
    expect(passed).toContain('Body paragraph.')
    // 关键：渲染器收到的内容绝不含 frontmatter 围栏或 YAML 行
    expect(passed).not.toContain('---')
    expect(passed).not.toContain('name:')
    expect(passed).not.toContain('triggers:')
  })

  it('源码/预览切换：源码态展示完整原文（含 frontmatter），预览态隐藏渲染器', async () => {
    const w = mountPreview({ content: SAMPLE, allowRawToggle: true })
    // 默认预览态：有渲染器、无 pre 源码
    expect(w.findComponent(MdStub).exists()).toBe(true)
    expect(w.find('pre').exists()).toBe(false)

    // 切到源码
    const srcBtn = w.findAll('button').find((b) => b.text().includes('源码'))!
    await srcBtn.trigger('click')
    expect(w.findComponent(MdStub).exists()).toBe(false)
    const pre = w.find('pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('name: notes') // 源码态保留完整 frontmatter
  })

  it('复制按钮：复制完整原文并显示「已复制」反馈', async () => {
    const w = mountPreview({ content: SAMPLE })
    const copyBtn = w.findAll('button').find((b) => b.text().includes('复制'))!
    await copyBtn.trigger('click')
    await flushPromises()
    expect(setClipboard).toHaveBeenCalledWith(SAMPLE)
    expect(w.text()).toContain('已复制')
  })

  it('allowRawToggle=false 时不渲染切换条（但仍有复制）', () => {
    const w = mountPreview({ content: SAMPLE, allowRawToggle: false })
    expect(w.findAll('button').some((b) => b.text().includes('源码'))).toBe(false)
    expect(w.findAll('button').some((b) => b.text().includes('复制'))).toBe(true)
  })

  it('空内容：显示占位、不渲染工具条与渲染器', () => {
    const w = mountPreview({ content: '   ' })
    expect(w.text()).toContain('暂无内容')
    expect(w.findComponent(MdStub).exists()).toBe(false)
    expect(w.findAll('button').length).toBe(0)
  })

  it('showFrontmatter：合法时展示 name/triggers/tags chips', () => {
    const w = mountPreview({ content: SAMPLE, showFrontmatter: true })
    const text = w.text()
    expect(text).toContain('notes')
    expect(text).toContain('/review')
    expect(text).toContain('/audit')
    expect(text).toContain('productivity')
  })

  it('showFrontmatter：缺 name 视为不合法，给出告警', () => {
    const noName = '---\ndescription: oops\n---\n# Body'
    const w = mountPreview({ content: noName, showFrontmatter: true })
    expect(w.text()).toContain('未检测到 name 字段')
  })

  it('showFrontmatter：有 name 但缺 description 时软提示', () => {
    const noDesc = '---\nname: x\n---\n# Body'
    const w = mountPreview({ content: noDesc, showFrontmatter: true })
    expect(w.text()).toContain('建议补充 description 字段')
  })
})
