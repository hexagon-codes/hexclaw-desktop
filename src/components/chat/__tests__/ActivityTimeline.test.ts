import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import ActivityTimeline from '../ActivityTimeline.vue'

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

describe('CHAT-INV-THINKING-008 shared ActivityTimeline', () => {
  it('renders ordered public activity states without owning task-shell behavior', () => {
    const wrapper = mount(ActivityTimeline, {
      props: {
        items: [
          {
            id: 'frozen',
            state: 'completed',
            label: '题目结构已冻结',
            detail: '共 4 个可作答小题',
          },
          { id: 'grading', state: 'running', label: '正在批改第 2 题', detail: '阶段预算 60 秒' },
        ],
      },
      global: { plugins: [testI18n()] },
    })

    const items = wrapper.findAll('[data-testid="activity-timeline-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.attributes('data-activity-state')).toBe('completed')
    expect(items[0]?.text()).toContain('题目结构已冻结')
    expect(items[1]?.attributes('data-activity-state')).toBe('running')
    expect(items[1]?.text()).toContain('正在批改第 2 题')
    expect(wrapper.find('[data-testid="activity-timeline-disclosure"]').exists()).toBe(false)
  })

  it('accepts the explicit K12 branch-grid presentation without changing item semantics', () => {
    const wrapper = mount(ActivityTimeline, {
      props: {
        layout: 'branch-grid',
        items: [
          {
            id: 'frozen',
            state: 'completed',
            label: '题目结构已冻结',
            detail: '共 4 个可作答小题',
          },
          { id: 'grading', state: 'running', label: '正在批改第 2 题', detail: '阶段预算 60 秒' },
        ],
      },
      global: { plugins: [testI18n()] },
    })

    const timeline = wrapper.get('[data-testid="activity-timeline"]')
    expect(timeline.attributes('data-activity-layout')).toBe('branch-grid')
    expect(timeline.classes()).toContain('hc-activity-timeline--branch-grid')
    expect(wrapper.findAll('[data-testid="activity-timeline-item"]')).toHaveLength(2)
    expect(
      wrapper.get('[data-testid="activity-timeline-item"]').attributes('data-activity-state'),
    ).toBe('completed')
  })
})
