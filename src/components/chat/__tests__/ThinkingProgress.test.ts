import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import type { RuntimeEvent } from '@/types/chat'
import ThinkingProgress from '../ThinkingProgress.vue'

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

type ProgressProps = {
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  elapsedSeconds: number
  reasoning?: string
  visibility?: 'visible' | 'not_exposed'
  defaultOpen?: boolean
  runtimeEvents?: RuntimeEvent[]
}

function mountProgress(props: ProgressProps) {
  return mount(ThinkingProgress, {
    props,
    global: { plugins: [testI18n()] },
  })
}

describe('CHAT-DEEP-THINK-PROGRESS-001 shared thinking lifecycle', () => {
  it('keeps the running public progress in one stable message-owned container', () => {
    const wrapper = mountProgress({
      state: 'running',
      elapsedSeconds: 19,
      reasoning: '正在检索教材中的相关知识点',
      visibility: 'visible',
      defaultOpen: true,
    })

    const progress = wrapper.get('[data-thinking-state="running"]')
    expect(progress.get('.hc-thinking__header').text()).toContain('正在思考')
    expect(progress.get('.hc-thinking__elapsed').text()).toContain('19s')
    expect(progress.get('.hc-thinking__content').text()).toContain('正在检索教材中的相关知识点')
    expect(progress.find('.hc-thinking__activity').exists()).toBe(true)
  })

  it('persists a completed collapsible summary after the answer starts', () => {
    const wrapper = mountProgress({
      state: 'completed',
      elapsedSeconds: 100,
      reasoning: '梳理了题目中的运算顺序',
      visibility: 'visible',
      defaultOpen: false,
    })

    const progress = wrapper.get('[data-thinking-state="completed"]')
    expect(progress.get('summary').text()).toContain('思考了')
    expect(progress.get('.hc-thinking__elapsed').text()).toContain('1m 40s')
    expect(progress.get('details').attributes('open')).toBeUndefined()
    expect(progress.text()).toContain('梳理了题目中的运算顺序')
  })

  it('retains a duration-only receipt without exposing private reasoning', () => {
    const wrapper = mountProgress({
      state: 'completed',
      elapsedSeconds: 12,
      reasoning: 'PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_RENDER',
      visibility: 'not_exposed',
      defaultOpen: true,
    })

    expect(wrapper.get('[data-thinking-state="completed"]').text()).toContain('思考了')
    expect(wrapper.text()).not.toContain('PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_RENDER')
    expect(wrapper.find('.hc-thinking__content').exists()).toBe(false)
    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.find('.cv').exists()).toBe(false)
  })

  it('projects safe runtime tool events through the shared timeline and coalesces one call', () => {
    const wrapper = mountProgress({
      state: 'completed',
      elapsedSeconds: 19,
      visibility: 'not_exposed',
      runtimeEvents: [
        {
          version: 1,
          sequence: 1,
          event_id: 'event-start',
          kind: 'tool_started',
          tool_call_id: 'call-weather',
          tool_name: 'weather',
        },
        {
          version: 1,
          sequence: 2,
          event_id: 'event-complete',
          kind: 'tool_completed',
          tool_call_id: 'call-weather',
          tool_name: 'weather',
        },
      ],
      defaultOpen: true,
    })

    const items = wrapper.findAll('[data-testid="activity-timeline-item"]')
    expect(items).toHaveLength(1)
    expect(items[0]?.text()).toContain('「天气查询」已完成')
    expect(wrapper.text()).not.toContain('weather')
  })

  it.each(['failed', 'cancelled'] as const)(
    'keeps the %s terminal state instead of removing the message progress',
    (state) => {
      const wrapper = mountProgress({
        state,
        elapsedSeconds: 8,
        reasoning: '',
        visibility: 'not_exposed',
      })

      expect(wrapper.find(`[data-thinking-state="${state}"]`).exists()).toBe(true)
      expect(wrapper.get('.hc-thinking__elapsed').text()).toContain('8s')
    },
  )

  it('is the single lifecycle renderer consumed by both history and streaming branches', () => {
    const chatViewPath = resolve(process.cwd(), 'src/views/ChatView.vue')
    const source = readFileSync(chatViewPath, 'utf8')
    const usages = source.match(/<ThinkingProgress\b/g) ?? []

    expect(source).toContain("import ThinkingProgress from '@/components/chat/ThinkingProgress.vue'")
    expect(usages).toHaveLength(1)
  })

  it('matches the approved completed icon, disclosure, aria-label, and natural-height contract', () => {
    const wrapper = mountProgress({
      state: 'completed',
      elapsedSeconds: 12,
      reasoning: '公开轨迹',
      visibility: 'visible',
      defaultOpen: true,
    })
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ThinkingProgress.vue'), 'utf8')

    expect(wrapper.get('summary').attributes('aria-label')).toBe('思考完成，点击收起')
    expect(wrapper.find('.ti svg').exists()).toBe(true)
    expect(wrapper.find('.cv').exists()).toBe(true)
    expect(source).not.toMatch(/max-height\s*:\s*240px/)
    expect(source).not.toMatch(/overflow(?:-y)?\s*:\s*(?:auto|hidden|scroll)/)
  })

  it('physically removes ResearchProgress and leaves one ThinkingProgress truth source', () => {
    expect(existsSync(resolve(process.cwd(), 'src/components/chat/ResearchProgress.vue'))).toBe(false)
    const chatViewSource = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')
    expect(chatViewSource).not.toContain('ResearchProgress')
    expect(chatViewSource.match(/<ThinkingProgress\b/g) ?? []).toHaveLength(1)
  })
})
