import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import TaskProgressCard from '../components/TaskProgressCard.vue'

function testI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountCard(
  props: InstanceType<typeof TaskProgressCard>['$props'],
) {
  return mount(TaskProgressCard, {
    props,
    global: { plugins: [testI18n()] },
  })
}

describe('K12-INV-TASK-PROGRESS-001 durable task shell', () => {
  it('uses one disclosure for the compact running summary and shared timeline', async () => {
    const wrapper = mountCard({
      state: 'running',
      summary: '正在批改作业　1/4　·　2 题需确认　·　已用时 00:42',
      ariaLabel: '已作答作业处理状态',
      items: [
        { id: 'frozen', state: 'completed', label: '题目结构已冻结' },
        { id: 'grading', state: 'running', label: '正在批改第 2 题', detail: '阶段预算 60 秒' },
      ],
    })

    expect(wrapper.get('[data-testid="task-progress-summary"]').text()).toContain(
      '正在批改作业　1/4　·　2 题需确认　·　已用时 00:42',
    )
    expect(wrapper.findAll('[data-testid="task-progress-disclosure"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('查看处理状态')
    expect(wrapper.text()).not.toContain('收起')

    await wrapper.get('[data-testid="task-progress-disclosure"]').trigger('click')
    expect(wrapper.find('[data-testid="activity-timeline"]').exists()).toBe(true)
  })

  it('persists the approved completed summary and a separate result action', async () => {
    const wrapper = mountCard({
      state: 'completed',
      summary: '作业批改完成　4 题　·　2 题需确认　·　用时 1 分 42 秒',
      ariaLabel: '已作答作业处理状态',
      items: [],
    })

    expect(wrapper.get('[data-testid="task-progress-summary"]').text()).toContain(
      '作业批改完成　4 题　·　2 题需确认　·　用时 1 分 42 秒',
    )
    expect(wrapper.get('[data-testid="task-progress-result"]').text()).toBe('查看结果 ›')
    await wrapper.get('[data-testid="task-progress-result"]').trigger('click')
    expect(wrapper.emitted('viewResult')).toHaveLength(1)
  })
})
