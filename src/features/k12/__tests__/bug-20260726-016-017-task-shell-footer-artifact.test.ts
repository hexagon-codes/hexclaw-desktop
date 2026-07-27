import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import FinalArtifactActions from '../components/FinalArtifactActions.vue'
import finalArtifactActionsSource from '../components/FinalArtifactActions.vue?raw'
import k12ChatEnhancementSource from '../views/K12ChatEnhancement.vue?raw'
import recognizeGuardPanelSource from '../views/RecognizeGuardPanel.vue?raw'

describe('BUG-20260726-016/017 TaskShell frozen footer and canonical artifact contract', () => {
  it('does not substitute the current composer route for a restored task frozen route', () => {
    expect(k12ChatEnhancementSource).not.toContain(
      ':display-provider="task.payload?.route?.provider || modelRoute?.provider"',
    )
    expect(k12ChatEnhancementSource).not.toContain(
      ':display-model="task.payload?.route?.model || modelRoute?.model"',
    )
  })

  it('does not drop a final artifact action at the TaskShell host boundary', () => {
    const panelStart = k12ChatEnhancementSource.indexOf('<RecognizeGuardPanel')
    const panelEnd = k12ChatEnhancementSource.indexOf('/>', panelStart)

    expect(panelStart).toBeGreaterThanOrEqual(0)
    expect(panelEnd).toBeGreaterThan(panelStart)
    expect(k12ChatEnhancementSource.slice(panelStart, panelEnd)).toContain(
      '@final-artifact-action=',
    )
  })

  it('keeps partial output non-exportable and sends one final digest through every action', async () => {
    expect(recognizeGuardPanelSource).toContain(
      'v-if="finalArtifact && finalArtifactID && finalArtifactDigest"',
    )
    expect(recognizeGuardPanelSource).toContain(':artifact-id="finalArtifactID"')
    expect(recognizeGuardPanelSource).toContain(
      ':artifact-digest="finalArtifactDigest"',
    )
    expect(finalArtifactActionsSource).toContain(
      'artifact_id: props.artifactId',
    )
    expect(finalArtifactActionsSource).toContain(
      'artifact_digest: props.artifactDigest',
    )

    const wrapper = mount(FinalArtifactActions, {
      props: {
        artifactId: 'grading-final-1',
        artifactDigest: 'canonical-final-artifact-digest',
        artifactTitle: '整页批改完成',
      },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual([
      '打印',
      '导出 PDF',
      '发送到手机',
    ])

    for (const button of buttons) await button.trigger('click')

    expect(wrapper.emitted('intent')?.map(([intent]) => intent)).toEqual([
      {
        action: 'print',
        artifact_id: 'grading-final-1',
        artifact_digest: 'canonical-final-artifact-digest',
        artifact_title: '整页批改完成',
      },
      {
        action: 'export_pdf',
        artifact_id: 'grading-final-1',
        artifact_digest: 'canonical-final-artifact-digest',
        artifact_title: '整页批改完成',
      },
      {
        action: 'send_im',
        artifact_id: 'grading-final-1',
        artifact_digest: 'canonical-final-artifact-digest',
        artifact_title: '整页批改完成',
      },
    ])
  })

  it('[BUG-20260727-006] projects disabled, primary, and delivery states in the shared action group', async () => {
    const wrapper = mount(FinalArtifactActions, {
      props: {
        artifactDigest: '',
        disabled: true,
        disabledReason: '当前没有可输出的题目',
        primaryAction: 'print',
        sendLabel: '发送中…',
        sendDisabled: true,
      },
    } as any)

    expect(wrapper.findAll('button').map((button) => button.text())).toEqual([
      '打印',
      '导出 PDF',
      '发送中…',
    ])
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined))
      .toBe(true)
    expect(wrapper.get('button').classes()).toContain('final-artifact-actions__primary')
    expect(wrapper.get('[role="status"]').text()).toBe('当前没有可输出的题目')

    for (const button of wrapper.findAll('button')) await button.trigger('click')
    expect(wrapper.emitted('intent')).toBeUndefined()
  })
})
