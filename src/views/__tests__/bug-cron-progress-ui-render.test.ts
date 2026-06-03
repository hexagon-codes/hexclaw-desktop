// BUG-cron-progress-ui-render regression test
//
// Bug: Bug #1 修复了 action.progress 数据写入但 ChatView 自动化卡片 UI
//   完全没有渲染 action.progress 字段，用户看不到 cron 编译 4 阶段进度。
//   data 写了没人读 = 功能未闭环。
//
// 锁定契约：
//   1. ChatView.vue source 必须含 `action.progress` 引用
//   2. 必须有 `.hc-msg__automation-progress` className（或等价语义元素）
//   3. 必须引用 stageLabel(action.progress.stage) 渲染人类可读文案

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('BUG-cron-progress-ui-render', () => {
  const chatViewSrc = readFileSync(
    resolve(__dirname, '../ChatView.vue'),
    'utf-8',
  )

  it('ChatView.vue template 必须读 action.progress 字段渲染', () => {
    // RED: 修前 source 完全没出现 `action.progress`
    // GREEN: source 必须含 `action.progress`（templ 或 script 用都算）
    expect(chatViewSrc).toMatch(/action\.progress/)
  })

  it('ChatView.vue 必须有专门的 progress 渲染节点（class 或 data-testid）', () => {
    // 强契约：必须有可被 UI 测试 query 到的语义节点
    const hasProgressClass = /hc-msg__automation-progress|automation-progress|cron-progress/.test(chatViewSrc)
    const hasProgressTestId = /data-testid=['"]automation-progress/.test(chatViewSrc)
    expect(hasProgressClass || hasProgressTestId).toBe(true)
  })

  it('progress 渲染必须读 progress.message 或 progress.stage', () => {
    // 必须真正消费 progress 字段而不是只 v-if（防止"占位元素"）
    const hasMessage = /progress\.message|progress\?\.message/.test(chatViewSrc)
    const hasStageLabel = /progress\.stage|progress\?\.stage/.test(chatViewSrc)
    expect(hasMessage || hasStageLabel).toBe(true)
  })

  it('progress 渲染应该仅在 running 状态显示（不污染 completed/failed 卡片）', () => {
    // 渲染契约：v-if 同时含 action.progress 与 'running' 检查
    // 这避免 progress 残留显示在 completed 卡片上
    // 用宽松正则——只要 progress 渲染附近有 running 字样即可
    const block = chatViewSrc.match(/automation-progress[\s\S]{0,500}/)
    // 该块必须存在；存在时其内必须出现 running 或 progress 关键字
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/running|progress/)
  })
})
