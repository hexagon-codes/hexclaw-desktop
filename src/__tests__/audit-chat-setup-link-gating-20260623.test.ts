import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// AUDIT 2026-06-23：会话空态「运行首次配置向导」提示，在已配置过模型时不应再显示。
// 判定与路由首屏守卫（router/index.ts）同款：有任一 provider，或已走完欢迎向导
// （welcomeCompleted）即视为已配置。这里用源码断言锁住门控（ChatView 依赖过重，不整体 mount）。
const src = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')
const router = readFileSync(resolve(process.cwd(), 'src/router/index.ts'), 'utf8')

describe('AUDIT 会话空态「运行首次配置向导」按已配置模型门控', () => {
  it('按钮由 !hasConfiguredModel 门控（已配置则隐藏）', () => {
    // setup-link 按钮存在且被 v-if 门控
    expect(src).toContain('hc-chat__setup-link')
    expect(src).toMatch(/v-if="!hasConfiguredModel"[\s\S]*hc-chat__setup-link|hc-chat__setup-link[\s\S]*?v-if="!hasConfiguredModel"/)
  })

  it('hasConfiguredModel 由 providers 数量或 welcomeCompleted 推导', () => {
    expect(src).toContain('hasConfiguredModel')
    expect(src).toMatch(/llm\.providers\?\.length/)
    expect(src).toContain('welcomeCompleted')
  })

  it('与路由守卫同款判定（providers.length + welcomeCompleted）', () => {
    // 路由守卫用同样两个信号决定是否跳 /welcome —— 两处保持一致，避免门控漂移
    expect(router).toMatch(/llm\.providers\?\.length/)
    expect(router).toContain('welcomeCompleted')
  })
})
