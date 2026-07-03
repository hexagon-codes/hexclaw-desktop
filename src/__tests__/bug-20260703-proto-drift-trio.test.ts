/**
 * bug-20260703 原型漂移审计三小修 · 源码契约回归锁
 *
 * 背景：原型 ↔ 实现全量漂移审计（2026-07-03）实锤三处实现侧缺陷：
 *  1. 连接页 tab 计数徽标断线 —— ConnectionChannelCards 已 emit('count')，
 *     ConnectionsView 无人接收，徽标被静默丢弃（原型 app.html「通道与账号 2」有计数）。
 *  2. 会话页参数条死代码 —— showChatParams 恒为 ref(false) 且无任何置 true 路径，
 *     1737-1763 的 Temperature/MaxTokens 面板永不可达（参数录入口归宿已定为
 *     编辑智能体弹窗高级区，会话内死模板应删；chatTemperature/chatMaxTokens
 *     与 chatStore 的同步链保留，行为不变）。
 *  3. 记忆卡「来源」不展示 —— source 字段仅作筛选维度，卡面无来源信息
 *     （原型卡面明示「类型：X · 来源：Y」）。
 *
 * 用与 bug-20260703-b6 相同的源码契约测试法钉死。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf-8')

describe('bug-20260703 原型漂移三小修', () => {
  it('1. ConnectionsView 必须接收 ConnectionChannelCards 的 count 并用于 tab 徽标', () => {
    const src = read('views/ConnectionsView.vue')
    // emit 有消费者：模板上绑定 @count
    expect(src).toContain('@count')
    // 计数进入 tab 标签（channelCount 参与 tabs 构造）
    expect(src).toContain('channelCount')
  })

  it('2. ChatView 不得残留不可达的 showChatParams 死模板', () => {
    const src = read('views/ChatView.vue')
    expect(src).not.toContain('showChatParams')
    // 参数同步链保留（行为不变的最小修）
    expect(src).toContain('chatTemperature')
  })

  it('3. MemoryView 卡面必须展示记忆来源', () => {
    const src = read('views/MemoryView.vue')
    expect(src).toContain('memory-source-badge')
  })
})
