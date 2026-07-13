/**
 * bug-20260713：Markdown 渲染升级为 GitHub 风格（GFM 语法 + GitHub 视觉规范）。
 *
 * 用户反馈：K12 题目/解答的 md 渲染「还不像 GitHub 格式」。本组件全 App 聊天/K12 复用，
 * 需向 github-markdown 看齐：GFM 语法（表格 / 删除线 / 任务列表 / 自动链接）+ GitHub 视觉。
 *
 * 只 mock shiki（异步高亮，与 GFM 无关），markdown-it / dompurify / katex 全用真实实现，
 * 以验证「渲染 → DOMPurify 净化」整条链路后 GFM 产物仍存活（真实风险：DOMPurify 剥 input/del）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MarkdownRenderer from '../MarkdownRenderer.vue'

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>x</code></pre>'),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function render(content: string) {
  return mount(MarkdownRenderer, {
    props: { content },
    global: {
      plugins: [createTestI18n()],
      stubs: { ArtifactRenderer: { template: '<div />' } },
    },
  })
}

describe('MarkdownRenderer · GFM 语法（GitHub Flavored Markdown）', () => {
  it('删除线 ~~x~~ 渲染成 <del>', () => {
    const html = render('这是 ~~删除的文字~~ 结束').html()
    expect(html).toContain('<del>')
    expect(html).toContain('删除的文字')
  })

  it('任务列表 - [x] 渲染成带 checkbox 的已勾选项', () => {
    const html = render('- [x] 已完成\n- [ ] 未完成').html()
    // GitHub 任务项：input[type=checkbox]，勾选态带 checked，禁用可点
    expect(html).toContain('type="checkbox"')
    expect(html).toMatch(/checked/) // 已完成那项应带 checked
    // 且经 DOMPurify 后 input 未被剥离
    expect(html.match(/type="checkbox"/g)?.length).toBe(2)
  })

  it('任务列表容器/项带 GitHub 类名（便于视觉样式挂载）', () => {
    const html = render('- [ ] 待办').html()
    expect(html).toContain('task-list-item')
    expect(html).toContain('contains-task-list')
  })

  it('表格渲染成 <table>（含表头/表体）', () => {
    const md = '| 学科 | 分数 |\n| --- | --- |\n| 数学 | 90 |'
    const html = render(md).html()
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('学科')
    expect(html).toContain('90')
  })

  it('自动链接 linkify：裸 URL 渲染成 <a>', () => {
    const html = render('访问 https://github.com 看看').html()
    expect(html).toContain('<a')
    expect(html).toContain('href="https://github.com"')
  })

  it('不破坏普通有序/无序列表渲染', () => {
    const html = render('1. 第一\n2. 第二').html()
    expect(html).toContain('<ol>')
    expect(html).toContain('第一')
    // 普通列表项不应被误标成 task-list-item
    expect(html).not.toContain('task-list-item')
  })
})

describe('MarkdownRenderer · GitHub 视觉规范（内联 style 规则存在性）', () => {
  it('组件内联了 GitHub 风格关键样式（h1/h2 分隔线、任务复选框、表格斑马纹）', async () => {
    const sourceCode = await import('../MarkdownRenderer.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : (sourceCode as { default: string }).default
    // h1/h2 底部分隔线
    expect(raw).toMatch(/h[12][\s\S]*?border-bottom/)
    // 任务列表复选框样式钩子
    expect(raw).toContain('task-list-item')
    // 表格斑马纹（偶数行底色）
    expect(raw).toContain('nth-child')
    // 深浅色主题：使用 --hc-* 变量而非写死颜色
    expect(raw).toContain('--hc-')
  })
})
