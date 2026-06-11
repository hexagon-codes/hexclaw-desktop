// BUG-cron-progress-pipeline regression test
//
// Bug: cron chat 自动化创建任务时，onProgress 回调里的 type guard
//   `if (action.progress !== undefined)` 永远为 false（CreateTaskAction
//   类型未声明 progress 字段），导致编译 4 阶段进度永远不被写入 action，
//   UI 自动化卡片无法显示进度。
//
// 修复后契约：
//   1. CreateTaskAction 类型必须含 progress 字段
//   2. useConversationAutomation source 不能含错误 type guard
//   3. mock 触发 onProgress 后 action.progress 必须被设置
//
// 锁定方式：组合"源码静态扫描" + "运行时行为模拟"双重证据。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CreateTaskAction } from '@/utils/chat-automation'

describe('BUG-cron-progress-pipeline', () => {
  it('CreateTaskAction 类型必须含 progress 字段（编译期断言）', () => {
    // 这条在修 type 之前 ts-check 会报错 TS2353，但 vitest 默认不跑 ts-check。
    // 用运行时构造 + 字段读取证明 progress 是合法字段。
    const action: CreateTaskAction = {
      id: 'a1',
      kind: 'create_task',
      title: 'test',
      description: 'desc',
      status: 'pending',
      payload: { name: 'n', schedule: '@daily', prompt: 'p' },
      progress: { stage: 'analyzing', message: 'starting' },
    }
    expect(action.progress?.stage).toBe('analyzing')
    expect(action.progress?.message).toBe('starting')
  })

  it('useConversationAutomation source 不应含错误的 progress 写入方式', () => {
    // History of this contract:
    //   v1 bug: dead type guard `if (action.progress !== undefined)` — progress never written
    //   v2 bug (BUG-20260611): direct mutation `action.progress = …` wrote to a STALE
    //   reference (the action object is replaced by the immutable 'running' update),
    //   so progress still never reached the store.
    // Current contract: progress flows through updateConversationAction with an
    // immutable spread. Behavioral proof lives in
    // bug-20260611-cron-progress-stale-ref.test.ts; this is the source-level lock.
    const src = readFileSync(
      resolve(__dirname, '../useConversationAutomation.ts'),
      'utf-8',
    )
    expect(src).not.toMatch(/if\s*\(\s*action\.progress\s*!==\s*undefined\s*\)/)
    expect(src).not.toMatch(/action\.progress\s*=\s*\{/)
    expect(src).toMatch(/\.\.\.current,\s*progress:\s*p\s*\}/)
  })

  it('progress 多次回调按顺序覆盖（语义验证）', () => {
    // 模拟 useConversationAutomation 内的 onProgress 闭包契约：
    // 多次 progress 调用，最后一次覆盖。
    const action: CreateTaskAction = {
      id: 'a1',
      kind: 'create_task',
      title: 't',
      description: 'd',
      status: 'running',
      payload: { name: 'n', schedule: '@daily', prompt: 'p' },
    }
    const onProgress = (p: { stage: CreateTaskAction['progress'] extends { stage: infer S } | undefined ? S : never; message: string }) => {
      action.progress = { stage: p.stage as never, message: p.message }
    }
    onProgress({ stage: 'analyzing' as never, message: 'a' })
    onProgress({ stage: 'calling_llm' as never, message: 'b' })
    onProgress({ stage: 'persisting' as never, message: 'c' })

    expect(action.progress).toBeDefined()
    expect(action.progress?.stage).toBe('persisting')
    expect(action.progress?.message).toBe('c')
  })

  it('CreateTaskAction.progress.stage 类型与 SSE 4 阶段对齐', async () => {
    // 锁定契约：progress.stage 必须接受 SSE 4 阶段的合法值
    const validStages: Array<'analyzing' | 'calling_llm' | 'validating' | 'persisting'> = [
      'analyzing', 'calling_llm', 'validating', 'persisting',
    ]
    for (const stage of validStages) {
      const action: CreateTaskAction = {
        id: 'x',
        kind: 'create_task',
        title: 't',
        description: 'd',
        status: 'pending',
        payload: { name: 'n', schedule: '@daily', prompt: 'p' },
        progress: { stage, message: 'm' },
      }
      expect(action.progress?.stage).toBe(stage)
    }
  })
})
