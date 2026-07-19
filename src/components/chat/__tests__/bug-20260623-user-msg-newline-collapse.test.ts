/**
 * BUG-20260623：粘贴的多行文本在用户气泡里换行丢失（塌成一段）。
 *
 * 根因：用户气泡用 `{{ msg.content }}` 裸文本节点渲染，外层 `.hc-msg__bubble--user`
 * 没有 white-space:pre-wrap → 浏览器默认 normal 把 `\n` 折叠成空格。
 * 修复：把内容渲染进带 white-space:pre-wrap 的专用元素 `MessageText`，
 * 并对过长内容提供 ChatGPT 式「展开/收起」。
 *
 * jsdom 不计算 CSS，无法直接断言视觉折叠；这里锁「内容逐字保留换行 + 折叠结构」。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MessageText from '../MessageText.vue'

function mountText(content: string) {
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
  return mount(MessageText, { props: { content }, global: { plugins: [i18n] } })
}

describe('MessageText — bug-20260623 user message newline + collapse', () => {
  it('preserves newlines verbatim in a pre-wrap text element (no collapse-to-space)', () => {
    const content = '第一段\n\n要求：\n1. 输出\n2. 设计主要角色'
    const w = mountText(content)
    const el = w.find('[data-testid="msg-text"]')
    expect(el.exists()).toBe(true)
    // 文本节点逐字等于原文（换行不丢）
    expect((el.element as HTMLElement).textContent).toBe(content)
    expect((el.element as HTMLElement).textContent).toContain('\n')
  })

  it('shows no expand toggle for short content', () => {
    const w = mountText('一句话消息')
    expect(w.find('[data-testid="msg-expand"]').exists()).toBe(false)
    expect(w.find('[data-testid="msg-text"]').classes()).not.toContain('hc-msg__text--collapsed')
  })

  it('collapses long multi-line content and toggles 展开 ↔ 收起', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')
    const w = mountText(long)
    const toggle = w.find('[data-testid="msg-expand"]')
    expect(toggle.exists()).toBe(true)
    // 默认折叠
    expect(w.find('[data-testid="msg-text"]').classes()).toContain('hc-msg__text--collapsed')
    expect(toggle.text()).toContain('展开')
    // 点击展开
    await toggle.trigger('click')
    expect(w.find('[data-testid="msg-text"]').classes()).not.toContain('hc-msg__text--collapsed')
    expect(toggle.text()).toContain('收起')
  })

  it('collapses very long single-paragraph content too (by length, no newlines)', () => {
    const w = mountText('啊'.repeat(600))
    expect(w.find('[data-testid="msg-expand"]').exists()).toBe(true)
  })

  it('renders pasted fractions while keeping ordinary Markdown syntax literal', () => {
    const w = mountText(String.raw`**题目**：\(\frac{3}{4}\) 的分数单位是什么？`)
    const el = w.get('[data-testid="msg-text"]')

    expect(el.find('.katex').exists()).toBe(true)
    expect(el.find('math mfrac').exists()).toBe(true)
    expect(el.text()).toContain('**题目**')
    expect(el.find('strong').exists()).toBe(false)
    const visibleText = el.element.cloneNode(true) as HTMLElement
    visibleText.querySelectorAll('.katex').forEach((node) => node.remove())
    expect(visibleText.textContent).not.toContain('\\frac')
  })

  it('renders legacy replies where Markdown already consumed the delimiter backslashes', () => {
    const w = mountText(String.raw`分数单位是 (\frac{1}{4})`)
    expect(w.get('[data-testid="msg-text"]').find('math mfrac').exists()).toBe(true)
  })

  it('does not execute HTML or render formulas inside pasted code', () => {
    const w = mountText('<img src=x onerror=alert(1)> `' + String.raw`\(x\)` + '`')
    const el = w.get('[data-testid="msg-text"]')

    expect(el.find('img').exists()).toBe(false)
    expect(el.find('.katex').exists()).toBe(false)
    expect(el.text()).toContain('<img src=x onerror=alert(1)>')
    expect(el.text()).toContain(String.raw`\(x\)`)
  })
})
