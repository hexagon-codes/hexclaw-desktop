/**
 * BUG-20260710 P1 · 前端渲染两件套(「hex 本身卡」次因):
 *  A. 流式 markdown 节流:每 chunk 全量重 parse(O(n²)/流)→ 至多 300ms 一次 + 尾帧必刷。
 *  B. 消息区窗口化:长会话全量 DOM → 默认渲染尾部 60 条 + 「显示更早」增量展开,切会话重置。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, nextTick, effectScope, watch } from 'vue'
import fs from 'node:fs'
import path from 'node:path'
import { useThrottledText } from '@/composables/useThrottledText'

const SRC = path.resolve(__dirname, '..')

describe('A · useThrottledText(流式节流)', () => {
  afterEach(() => vi.useRealTimers())

  it('★高频写入只按节流间隔出帧,尾帧必达最终值', async () => {
    vi.useFakeTimers()
    const src = ref('')
    const scope = effectScope()
    let out!: ReturnType<typeof useThrottledText>
    scope.run(() => { out = useThrottledText(() => src.value, 300) })

    let renders = 0
    scope.run(() => {
      // 计渲染次数:watch mirror
      watch(out, () => { renders++ })
    })

    // 模拟 20 个 chunk,每 30ms 一个(600ms 内)
    for (let i = 1; i <= 20; i++) {
      src.value = 'x'.repeat(i)
      await nextTick()
      vi.advanceTimersByTime(30)
    }
    vi.advanceTimersByTime(400) // 排空尾帧
    await nextTick()

    expect(out.value, '尾帧必须等于最终内容').toBe('x'.repeat(20))
    expect(renders, '20 个 chunk 应折叠为少数帧(≤5)').toBeLessThanOrEqual(5)
    scope.stop()
  })

  it('清空(流结束)立即透传,不留残影', async () => {
    vi.useFakeTimers()
    const src = ref('abc')
    const scope = effectScope()
    let out!: ReturnType<typeof useThrottledText>
    scope.run(() => { out = useThrottledText(() => src.value, 300) })
    src.value = 'abcdef'; await nextTick()
    src.value = ''; await nextTick()
    expect(out.value).toBe('')
    scope.stop()
  })
})

describe('B · 消息区窗口化(源锁,行为由 ChatView 集成测试与 live 门守)', () => {
  it('★ChatView 消息循环走 visibleMessages 窗口而非全量 messages', () => {
    const body = fs.readFileSync(path.join(SRC, 'views/ChatView.vue'), 'utf8')
    expect(body).toContain('v-for="(msg, idx) in visibleMessages"')
    expect(body).toContain('const visibleMessages = computed')
    // 「显示更早」入口 + 切会话重置
    expect(body).toContain('data-testid="chat-show-earlier"')
    expect(body).toMatch(/messageWindow\.value = MESSAGE_WINDOW_INITIAL/)
  })

  it('★流式气泡使用节流镜像而非原始流内容直喂 MarkdownRenderer', () => {
    const body = fs.readFileSync(path.join(SRC, 'views/ChatView.vue'), 'utf8')
    expect(body).toContain('useThrottledText')
    expect(body).toContain('<MarkdownRenderer :content="throttledStreamContent"')
    expect(body).not.toContain('<MarkdownRenderer :content="chatStore.isCurrentStreamingContent"')
  })
})
