import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import FinalArtifactActions from '../components/FinalArtifactActions.vue'

type StateCase = {
  name: string
  props: {
    disabled?: boolean
    disabledReason?: string
    sendLabel?: string
    sendDisabled?: boolean
  }
  labels: [string, string, string]
  disabled: [boolean, boolean, boolean]
  intentCount: number
}

const states: StateCase[] = [
  {
    name: 'zero items',
    props: { disabled: true, disabledReason: '当前没有可输出的题目' },
    labels: ['打印', '导出 PDF', '发送到手机'],
    disabled: [true, true, true],
    intentCount: 0,
  },
  {
    name: 'available output',
    props: {},
    labels: ['打印', '导出 PDF', '发送到手机'],
    disabled: [false, false, false],
    intentCount: 3,
  },
  {
    name: 'output busy',
    props: { disabled: true, disabledReason: '正在处理本周计划…' },
    labels: ['打印', '导出 PDF', '发送到手机'],
    disabled: [true, true, true],
    intentCount: 0,
  },
  {
    name: 'delivery sending',
    props: { sendLabel: '发送中…', sendDisabled: true },
    labels: ['打印', '导出 PDF', '发送中…'],
    disabled: [false, false, true],
    intentCount: 2,
  },
  {
    name: 'delivery succeeded',
    props: { sendLabel: '发送成功', sendDisabled: true },
    labels: ['打印', '导出 PDF', '发送成功'],
    disabled: [false, false, true],
    intentCount: 2,
  },
  {
    name: 'delivery failed',
    props: { sendLabel: '发送失败 · 重试' },
    labels: ['打印', '导出 PDF', '发送失败 · 重试'],
    disabled: [false, false, false],
    intentCount: 3,
  },
]

describe('BUG-20260727-006 weekly output state projection', () => {
  it('[K12-WEEKLY-042] lets the weekly context project only print and phone delivery', async () => {
    const wrapper = mount(FinalArtifactActions, {
      props: {
        artifactId: 'artifact-30',
        artifactDigest: 'sha256:immutable-weekly-30',
        artifactTitle: '本周该练',
        primaryAction: 'print',
        actions: ['print', 'send_im'],
      } as any,
    })

    expect(wrapper.findAll('button').map((button) => button.text())).toEqual([
      '打印',
      '发送到手机',
    ])
    for (const button of wrapper.findAll('button')) await button.trigger('click')
    expect(wrapper.emitted('intent')?.map(([intent]) => intent)).toMatchObject([
      { action: 'print' },
      { action: 'send_im' },
    ])
  })

  it.each(states)(
    '[K12-WEEKLY-046] $name keeps the shared controls and zero-submission guards',
    async ({ props, labels, disabled, intentCount }) => {
      const wrapper = mount(FinalArtifactActions, {
        props: {
          artifactId: 'artifact-30',
          artifactDigest: 'sha256:immutable-weekly-30',
          artifactTitle: '本周该练',
          primaryAction: 'print',
          ...props,
        },
      })
      const buttons = wrapper.findAll('button')

      expect(buttons.map((button) => button.text())).toEqual(labels)
      expect(
        buttons.map((button) => button.attributes('disabled') !== undefined),
      ).toEqual(disabled)
      expect(buttons[0]!.classes()).toContain('final-artifact-actions__primary')
      if (props.disabledReason) {
        expect(wrapper.get('[role="status"]').text()).toBe(props.disabledReason)
      } else {
        expect(wrapper.find('[role="status"]').exists()).toBe(false)
      }

      for (const button of buttons) await button.trigger('click')
      const intents = wrapper.emitted('intent')?.map(([intent]) => intent) ?? []
      expect(intents).toHaveLength(intentCount)
      expect(
        intents.every(
          (intent) =>
            (intent as { artifact_digest: string }).artifact_digest ===
            'sha256:immutable-weekly-30',
        ),
      ).toBe(true)
    },
  )
})
