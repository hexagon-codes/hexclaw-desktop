/**
 * BUG-20260628 IM 绑定 Agent「无活入口」+ ConnectionsView NUL 损坏 — 结构守卫
 *
 * 评审取证发现两个 bug：
 *  ① 绑定 Agent 的 UI 全写在 `views/IMChannelsView.vue`，但该 view 是**孤儿**（无路由、无 importer）；
 *     活的「连接 → 通道与账号」走 `/channels → ConnectionsView → ConnectionChannelCards`，后者**无**
 *     绑定入口 → 整个 IM↔Agent 绑定功能用户**不可达**（功能未闭环）。
 *  ② `views/ConnectionsView.vue` 混入 NUL 字节 → `file` 判为二进制、grep/diff 工具失灵。
 *
 * 本守卫钉死：
 *  - ConnectionsView.vue 不得含 NUL 字节（文本完整）。
 *  - 绑定 Agent UI 必须从 `/channels` 路由**可达**：router → ConnectionsView → ConnectionChannelCards
 *    → ChannelAgentBinding 链路完整（末环现缺 → RED）。防再把入口建进孤儿 view（举一反三·防复发）。
 *
 * 注：JS 正则 .test() 对字符串里散落的 NUL 字节无感（只有 file/grep 等字节工具判二进制），故链路断言直接 read()。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')
const countNul = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0) n++
  return n
}

describe('BUG-20260628 ② ConnectionsView.vue 文本完整（无 NUL 损坏）', () => {
  it('ConnectionsView.vue 不含 NUL 字节', () => {
    const n = countNul(read('views/ConnectionsView.vue'))
    expect(n, `ConnectionsView.vue 含 ${n} 个 NUL 字节（被损坏成二进制）`).toBe(0)
  })
})

describe('BUG-20260628 ① 绑定 Agent UI 必须从 /channels 路由可达（防孤儿入口）', () => {
  it('router: channels 路由 → ConnectionsView', () => {
    const router = read('router/index.ts')
    expect(/channels:\s*\(\)\s*=>\s*import\(['"]@\/views\/ConnectionsView\.vue['"]\)/.test(router),
      'router 应把 channels 路由指向 ConnectionsView').toBe(true)
  })

  it('ConnectionsView 渲染 ConnectionChannelCards', () => {
    const cv = read('views/ConnectionsView.vue')
    expect(/import\s+ConnectionChannelCards/.test(cv), 'ConnectionsView 应 import ConnectionChannelCards').toBe(true)
    expect(/<ConnectionChannelCards/.test(cv), 'ConnectionsView 模板应渲染 <ConnectionChannelCards>').toBe(true)
  })

  it('★末环：活的渠道卡 ConnectionChannelCards 必须渲染绑定控件 ChannelAgentBinding', () => {
    const cards = read('components/channels/ConnectionChannelCards.vue')
    expect(/import\s+ChannelAgentBinding/.test(cards),
      'ConnectionChannelCards 应 import ChannelAgentBinding（绑定 Agent 入口）').toBe(true)
    expect(/<ChannelAgentBinding/.test(cards),
      'ConnectionChannelCards 卡片模板应渲染 <ChannelAgentBinding>（否则用户无绑定入口）').toBe(true)
  })
})
