/**
 * BUG-20260622-R2 — 会话自动化「自然语言 → cron」二轮挑刺取证。
 *
 * 经探针实测确认（非静态猜测）的两处运行时缺陷，RED→GREEN 回归锁：
 *
 *   H  chat-automation.ts:180/188  `每N分钟`/`每N小时`/`每隔N分钟` 死正则
 *       正则 `/每\s*(\d+)\s*(分钟|分)\b/` 末尾 `\b` 紧跟 CJK，无 `u` 标志时
 *       CJK 不算 \w，CJK↔CJK/行尾间无单词边界 → 永不匹配 → 整条 fast-path 失效，
 *       用户「每30分钟…」拿不到任何自动化卡片（静默失败）。
 *
 *   I  chat-automation.ts:255       12 小时制「晚上/夜里/凌晨 12 点」误算为中午
 *       `hour < 12` 把 hour===12 漏掉 → `晚上12点`(=午夜) 生成 `0 12`(中午)，偏 12h。
 *       区别于已修的「晚上0点」(hour===0) 缺陷。
 */
import { describe, it, expect } from 'vitest'
import { buildConversationAutomationActions } from '@/utils/chat-automation'

function schedOf(userText: string): string | undefined {
  const actions = buildConversationAutomationActions({ userText, sourceMessageId: 'm1' })
  const task = actions.find((a) => a.kind === 'create_task') as
    | { payload?: { schedule?: string } }
    | undefined
  return task?.payload?.schedule
}

describe('H [P1] chat-automation: 每N分钟/每N小时/每隔N分钟 必须生成 @every', () => {
  it('「每30分钟」→ @every 30m（不再静默无卡）', () => {
    expect(schedOf('创建每30分钟检查汇率的定时任务')).toBe('@every 30m')
  })
  it('「每隔45分钟」→ @every 45m', () => {
    expect(schedOf('创建每隔45分钟巡检的定时任务')).toBe('@every 45m')
  })
  it('「每3小时」→ @every 3h', () => {
    expect(schedOf('创建每3小时同步数据的定时任务')).toBe('@every 3h')
  })
  it('控制组：「每小时」仍 @every 1h；字面 @every 30m 透传', () => {
    expect(schedOf('创建每小时巡检的定时任务')).toBe('@every 1h')
    expect(schedOf('创建定时任务 @every 30m 巡检')).toBe('@every 30m')
  })
})

describe('K [P1] chat-automation: 标准 cron 字符串抽取（以 * 结尾不再漏）', () => {
  it('「30 8 * * *」可被抽取（DOW=* 结尾）', () => {
    expect(schedOf('创建定时任务 30 8 * * * 发早报')).toBe('30 8 * * *')
  })
  it('「*/5 * * * *」可被抽取（首尾皆含 *）', () => {
    expect(schedOf('创建定时任务 */5 * * * * 监控汇率')).toBe('*/5 * * * *')
  })
  it('「0 0 1 * *」可被抽取（月初备份）', () => {
    expect(schedOf('创建定时任务 0 0 1 * * 月初备份')).toBe('0 0 1 * *')
  })
  it('控制组：数字结尾 cron 仍正常；散文数字仍被拒（非法 minute>59 不入库）', () => {
    expect(schedOf('创建定时任务 0 9 * * 1 发周报')).toBe('0 9 * * 1')
    // 散文数字「2026 6 22 15 30」即便被当 cron 抽取，isPlausibleCron 也应拒绝（minute=2026>59）
    const proseMinute = Number((schedOf('创建定时任务 2026 6 22 15 30 开会提醒') ?? '').split(/\s+/)[0])
    expect(Number.isInteger(proseMinute) && proseMinute > 59).toBe(false)
  })
})

describe('I [P2] chat-automation: 晚上/夜里/凌晨 12 点 = 午夜，不是中午', () => {
  it('「每天晚上12点」→ 0 0 * * *（午夜）', () => {
    expect(schedOf('创建每天晚上12点清理的定时任务')).toBe('0 0 * * *')
  })
  it('「每天夜里12点」→ 0 0 * * *（午夜）', () => {
    expect(schedOf('创建每天夜里12点清理的定时任务')).toBe('0 0 * * *')
  })
  it('「每天凌晨12点」→ 0 0 * * *（午夜）', () => {
    expect(schedOf('创建每天凌晨12点清理的定时任务')).toBe('0 0 * * *')
  })
  it('控制组：中午12点=正午、下午1点=13、晚上8点=20、凌晨3点=3', () => {
    expect(schedOf('创建每天中午12点清理的定时任务')).toBe('0 12 * * *')
    expect(schedOf('创建每天下午1点清理的定时任务')).toBe('0 13 * * *')
    expect(schedOf('创建每天晚上8点清理的定时任务')).toBe('0 20 * * *')
    expect(schedOf('创建每天凌晨3点清理的定时任务')).toBe('0 3 * * *')
  })
})
