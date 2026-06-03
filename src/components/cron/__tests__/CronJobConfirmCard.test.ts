/**
 * D3.3 可编辑确认卡 regression tests
 *
 * RED 场景：
 *   - 旧自动化卡片 read-only，schedule 编错只能取消重发
 *   - 没有 cron 表达式预览，K12 家长看不懂 0 8 * * *
 *   - 没有 tier badge，不知道是 fast-path 还是 LLM 解析
 *   - 没有配额预警，到上限才报错（30 个 task）
 *
 * GREEN 守护：
 *   - 修改模式 toggle 后 4 个字段可编辑
 *   - cron 五段 / @daily / @every Nm 都翻成中文预览
 *   - sourceTier '1' 显 ⚡ 已识别，'2' 显 🤖 AI 协助
 *   - 配额预警：≤3 个 warn，0 个 block 阻止提交
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CronJobConfirmCard from '@/components/cron/CronJobConfirmCard.vue'
import type { CreateTaskAction } from '@/utils/chat-automation'

function makeAction(): CreateTaskAction {
  return {
    id: 'a1',
    kind: 'create_task',
    title: '创建定时任务',
    description: '每天 8 点采集新闻',
    status: 'pending',
    payload: {
      name: '每日新闻',
      schedule: '0 8 * * *',
      prompt: '采集新闻头条',
    },
  }
}

describe('CronJobConfirmCard — D3.3', () => {
  it('默认渲染 read-only 视图含 schedule 预览', () => {
    const w = mount(CronJobConfirmCard, {
      props: { action: makeAction(), sourceTier: '1' },
    })
    expect(w.text()).toContain('每日新闻')
    // 0 8 * * * → 每天 08:00 预览
    expect(w.text()).toMatch(/每天\s*08:00/)
  })

  it('tier badge 按 sourceTier 切换', () => {
    const w1 = mount(CronJobConfirmCard, {
      props: { action: makeAction(), sourceTier: '1' },
    })
    expect(w1.text()).toContain('已识别')

    const w2 = mount(CronJobConfirmCard, {
      props: { action: makeAction(), sourceTier: '2' },
    })
    expect(w2.text()).toContain('AI 协助')

    const w3 = mount(CronJobConfirmCard, {
      props: { action: makeAction(), sourceTier: '0' },
    })
    expect(w3.text()).toContain('Slash')

    const w4 = mount(CronJobConfirmCard, {
      props: { action: makeAction(), sourceTier: '3' },
    })
    expect(w4.text()).toContain('待补全')
  })

  it('@daily 翻成「每天 0:00」', async () => {
    const action = makeAction()
    action.payload.schedule = '@daily'
    const w = mount(CronJobConfirmCard, { props: { action } })
    expect(w.text()).toContain('每天 0:00')
  })

  it('@every 5m 翻成「每 5 分钟」', async () => {
    const action = makeAction()
    action.payload.schedule = '@every 5m'
    const w = mount(CronJobConfirmCard, { props: { action } })
    expect(w.text()).toContain('每 5 分钟')
  })

  it('点击「修改」展开 form，可编辑 4 字段 + deliver chips', async () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    await w.find('.cron-card__edit-toggle').trigger('click')
    const inputs = w.findAll('input')
    expect(inputs.length).toBeGreaterThanOrEqual(2) // name + schedule
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.findAll('.cron-card__chip').length).toBeGreaterThanOrEqual(5) // chat/push/feishu/discord/wechat
  })

  it('点击「确认创建」emit execute(payload)', async () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    await w.find('.cron-card__btn--primary').trigger('click')
    expect(w.emitted('execute')).toBeTruthy()
    const payload = w.emitted('execute')![0]![0] as { name: string; schedule: string; prompt: string; deliver?: string[] }
    expect(payload.name).toBe('每日新闻')
    expect(payload.schedule).toBe('0 8 * * *')
    expect(payload.deliver).toEqual(['chat'])
  })

  it('配额满（used=limit）→ block 提示 + 提交按钮禁用', () => {
    const w = mount(CronJobConfirmCard, {
      props: { action: makeAction(), quotaUsed: 30, quotaLimit: 30 },
    })
    expect(w.text()).toContain('配额已满')
    const btn = w.find('.cron-card__btn--primary').element as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('配额接近上限（remaining=2）→ warn 提示但允许提交', () => {
    const w = mount(CronJobConfirmCard, {
      props: { action: makeAction(), quotaUsed: 28, quotaLimit: 30 },
    })
    expect(w.text()).toContain('剩余 2 个名额')
    const btn = w.find('.cron-card__btn--primary').element as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('配额未提供 → 不显示预警', () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    expect(w.find('.cron-card__quota').exists()).toBe(false)
  })

  it('编辑模式点「AI 帮我改」emit reparse(combined text)', async () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    await w.find('.cron-card__edit-toggle').trigger('click')
    await w.find('.cron-card__btn--ghost').trigger('click')
    expect(w.emitted('reparse')).toBeTruthy()
    const arg = w.emitted('reparse')![0]![0]
    expect(String(arg)).toContain('采集新闻')
  })

  it('点「取消」emit dismiss', async () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    // 取消按钮是最后一个非 primary / 非 ghost 的按钮
    const btns = w.findAll('.cron-card__btn').filter(
      (b) => !b.classes('cron-card__btn--primary') && !b.classes('cron-card__btn--ghost')
    )
    await btns[btns.length - 1]!.trigger('click')
    expect(w.emitted('dismiss')).toBeTruthy()
  })

  it('五段 cron 表达式中复杂的不翻译，原样显示', () => {
    const action = makeAction()
    action.payload.schedule = '*/15 9-17 * * 1-5' // 工作日 9-17 每 15min
    const w = mount(CronJobConfirmCard, { props: { action } })
    // 复杂表达式不翻译，显示原文
    expect(w.text()).toContain('*/15 9-17 * * 1-5')
  })

  it('清空 name 字段后提交按钮禁用', async () => {
    const w = mount(CronJobConfirmCard, { props: { action: makeAction() } })
    await w.find('.cron-card__edit-toggle').trigger('click')
    const nameInput = w.find('input')
    await nameInput.setValue('')
    const btn = w.find('.cron-card__btn--primary').element as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
