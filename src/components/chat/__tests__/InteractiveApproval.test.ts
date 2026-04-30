import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractiveApproval from '../InteractiveApproval.vue'

describe('InteractiveApproval', () => {
  const baseApproval = {
    subject: '是否允许在 /tmp 写入文件？',
    summary: '工具 fs.write 即将创建 README.md',
  }

  it('渲染 subject + summary + 默认 同意/拒绝 文案', () => {
    const w = mount(InteractiveApproval, { props: { approval: baseApproval } })
    expect(w.text()).toContain('是否允许在 /tmp 写入文件？')
    expect(w.text()).toContain('工具 fs.write 即将创建 README.md')
    const btns = w.findAll('button')
    expect(btns).toHaveLength(2)
    expect(btns[0]!.text()).toContain('同意')
    expect(btns[1]!.text()).toContain('拒绝')
  })

  it('自定义 label/action 生效', async () => {
    const w = mount(InteractiveApproval, {
      props: {
        approval: {
          subject: 'Confirm?',
          approve_label: 'Yes',
          reject_label: 'No',
          approve_action: 'yes',
          reject_action: 'no',
        },
      },
    })
    const btns = w.findAll('button')
    expect(btns[0]!.text()).toContain('Yes')
    expect(btns[1]!.text()).toContain('No')

    await btns[0]!.trigger('click')
    const events = w.emitted('select')!
    expect(events[0]![0]).toMatchObject({ action: 'yes', label: 'Yes', approved: true })
  })

  it('点击同意/拒绝 emit 正确 approved 标志', async () => {
    const w = mount(InteractiveApproval, { props: { approval: baseApproval } })
    await w.findAll('button')[0]!.trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ action: 'approve', approved: true })

    const w2 = mount(InteractiveApproval, { props: { approval: baseApproval } })
    await w2.findAll('button')[1]!.trigger('click')
    expect(w2.emitted('select')![0]![0]).toMatchObject({ action: 'reject', approved: false })
  })

  it('resolved 后两个按钮都禁用 + 已同意/已拒绝 hint', () => {
    const w = mount(InteractiveApproval, {
      props: {
        approval: baseApproval,
        resolved: { action: 'approve', approved: true },
      },
    })
    const btns = w.findAll('button')
    btns.forEach(b => expect(b.attributes('disabled')).toBeDefined())
    expect(btns[0]!.classes()).toContain('is-resolved')
    expect(w.text()).toContain('已同意')

    const w2 = mount(InteractiveApproval, {
      props: {
        approval: baseApproval,
        resolved: { action: 'reject', approved: false },
      },
    })
    expect(w2.text()).toContain('已拒绝')
  })
})
