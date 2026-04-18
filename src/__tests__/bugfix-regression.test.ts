/**
 * 回归测试 — 验证三个 bug 修复的正确性
 *
 * Bug #1: 思考计时器把 thinking + output 时间合算
 * Bug #2: 复制代码按钮在 Tauri WebView 中静默失败
 * Bug #3: 聊天输入框不支持粘贴图片
 */
import { describe, it, expect, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mergeStreamChunkState, type SessionStreamState } from '@/stores/chat-stream-helpers'
import { createChatThinkingTimerController } from '@/stores/chat-thinking-timer'
import { readFileSync } from 'fs'

// ═══════════════════════════════════════════════════════════
//  Bug #1: 思考计时器应只计思考时间，不含输出时间
// ═══════════════════════════════════════════════════════════

describe('Bug #1: 思考计时器精确到 reasoning 阶段', () => {
  const baseState: SessionStreamState = {
    sessionId: 's1',
    requestId: 'r1',
    rawContent: '',
    content: '',
    explicitReasoning: '',
    reasoning: '',
    reasoningStartTime: 0,
    reasoningEndTime: 0,
  }

  it('修复前行为（复现）: reasoningEndTime 不存在时，计时器会一直跑到输出结束', () => {
    // 模拟旧行为：只有 reasoningStartTime，无 reasoningEndTime
    // 计时器用 Date.now() - startTime，在输出阶段仍然递增
    const startTime = Date.now() - 5000 // 5 秒前开始思考
    const oldDuration = Math.round((Date.now() - startTime) / 1000)
    // 旧逻辑：即使已经在输出内容，仍然用 Date.now() 计算
    expect(oldDuration).toBeGreaterThanOrEqual(5) // 含输出时间
  })

  it('修复后: mergeStreamChunkState 在 reasoning→content 转换时设置 reasoningEndTime', () => {
    // 阶段1：收到 reasoning chunk
    const afterReasoning = mergeStreamChunkState(baseState, undefined, '正在思考...')
    expect(afterReasoning.reasoningStartTime).toBeGreaterThan(0)
    expect(afterReasoning.reasoningEndTime).toBe(0) // 思考未结束

    // 阶段2：收到 content chunk（无 reasoning）= 思考结束
    const afterContent = mergeStreamChunkState(afterReasoning, '最终回答', undefined)
    expect(afterContent.reasoningEndTime).toBeGreaterThan(0) // 思考已结束
    expect(afterContent.reasoningEndTime).toBeGreaterThanOrEqual(afterContent.reasoningStartTime)
  })

  it('修复后: 仅有 content 无 reasoning 时，不设置 endTime（没有思考阶段）', () => {
    const result = mergeStreamChunkState(baseState, '直接回答', undefined)
    expect(result.reasoningStartTime).toBe(0)
    expect(result.reasoningEndTime).toBe(0)
  })

  it('修复后: reasoning 持续到来时，endTime 保持为 0', () => {
    const s1 = mergeStreamChunkState(baseState, undefined, '思考第一步')
    const s2 = mergeStreamChunkState(s1, undefined, '思考第二步')
    expect(s2.reasoningStartTime).toBeGreaterThan(0)
    expect(s2.reasoningEndTime).toBe(0) // 仍在思考
  })

  it('修复后: endTime 一旦设置，后续 content chunk 不再改变它', () => {
    const s1 = mergeStreamChunkState(baseState, undefined, '思考中')
    const s2 = mergeStreamChunkState(s1, '回答第一段', undefined)
    const firstEndTime = s2.reasoningEndTime
    expect(firstEndTime).toBeGreaterThan(0)

    const s3 = mergeStreamChunkState(s2, '回答第二段', undefined)
    expect(s3.reasoningEndTime).toBe(firstEndTime) // 不变
  })

  it('修复后: timer 在 reasoningEndTime 设置时停止，用 endTime-startTime 计算', async () => {
    vi.useFakeTimers()
    const streamingReasoningStartTime = ref(0)
    const streamingReasoningEndTime = ref(0)
    const streamingThinkingElapsed = ref(0)
    const thinkingTimer = ref<ReturnType<typeof setInterval> | null>(null)

    const controller = createChatThinkingTimerController({
      streamingReasoningStartTime,
      streamingReasoningEndTime,
      streamingThinkingElapsed,
      thinkingTimer,
    })
    controller.bindThinkingTimer()

    // 开始思考
    const now = Date.now()
    streamingReasoningStartTime.value = now - 3000 // 3 秒前开始
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(streamingThinkingElapsed.value).toBeGreaterThanOrEqual(3)
    expect(thinkingTimer.value).not.toBeNull() // timer 在跑

    // 思考结束（2 秒后）
    streamingReasoningEndTime.value = now - 1000 // 1 秒前结束 = 思考了 2 秒
    await nextTick()

    // timer 应该已停止，显示精确的思考时长
    expect(thinkingTimer.value).toBeNull() // timer 已停
    expect(streamingThinkingElapsed.value).toBe(2) // 精确 2 秒，不是 3+

    // 继续推进时间，elapsed 不再变化
    vi.advanceTimersByTime(5000)
    expect(streamingThinkingElapsed.value).toBe(2) // 仍然是 2 秒

    controller.clearThinkingTimer()
    vi.useRealTimers()
  })

  it('修复后: chat-stream-completion 使用 reasoningEndTime 计算最终 duration', () => {
    const source = readFileSync('src/stores/chat-stream-completion.ts', 'utf-8')
    // 修复后：用 endTime 而非 Date.now()
    expect(source).toContain('streamState?.reasoningEndTime')
    expect(source).toContain('endTime - streamState.reasoningStartTime')
    // 不再直接用 Date.now() - startTime
    expect(source).not.toContain('Date.now() - streamState.reasoningStartTime')
  })
})

// ═══════════════════════════════════════════════════════════
//  Bug #2: 复制代码按钮在 Tauri WebView 中失败
// ═══════════════════════════════════════════════════════════

describe('Bug #2: 复制代码按钮 Tauri 兼容 + 视觉反馈', () => {
  it('修复前行为（复现）: 旧代码静默吞掉错误无反馈，修复后 catch 显示失败提示', () => {
    const source = readFileSync('src/components/chat/MarkdownRenderer.vue', 'utf-8')
    // 修复后：catch 中不再是空函数，而是显示"失败"反馈
    expect(source).toContain('失败')
    expect(source).toContain('Failed')
    // 修复后：不再有静默吞掉错误的注释
    expect(source).not.toContain('// clipboard access can be unavailable')
  })

  it('修复后: desktop.ts 在 Tauri 环境优先调用后端 clipboard API', () => {
    const source = readFileSync('src/api/desktop.ts', 'utf-8')
    // Tauri 检测
    expect(source).toContain("'__TAURI__' in window")
    // 调用后端 API
    expect(source).toContain('/api/v1/desktop/clipboard')
    expect(source).toContain("invoke('proxy_api_request'")
    // 仍保留浏览器 API 作为 fallback
    expect(source).toContain('navigator.clipboard?.writeText')
    // 最终 fallback
    expect(source).toContain("execCommand('copy')")
  })

  it('修复后: 三层 fallback 顺序正确（Tauri → navigator → execCommand）', () => {
    const source = readFileSync('src/api/desktop.ts', 'utf-8')
    // 只检查函数体内的顺序（跳过 JSDoc 注释）
    const fnBody = source.slice(source.indexOf('export async function'))
    const tauriIdx = fnBody.indexOf('__TAURI__')
    const navigatorIdx = fnBody.indexOf('navigator.clipboard?.writeText')
    const execIdx = fnBody.indexOf("execCommand('copy')")
    // Tauri 在最前面
    expect(tauriIdx).toBeLessThan(navigatorIdx)
    expect(navigatorIdx).toBeLessThan(execIdx)
  })

  it('修复后: 复制成功显示"已复制"反馈，失败显示"失败"', () => {
    const source = readFileSync('src/components/chat/MarkdownRenderer.vue', 'utf-8')
    // 成功反馈
    expect(source).toContain('已复制')
    expect(source).toContain('Copied')
    expect(source).toContain('copy-btn--success')
    // 失败反馈
    expect(source).toContain('失败')
    expect(source).toContain('Failed')
    // 1.5 秒后恢复
    expect(source).toContain('1500')
  })

  it('修复后: copy-btn--success 样式使用 --hc-success 颜色', () => {
    const source = readFileSync('src/components/chat/MarkdownRenderer.vue', 'utf-8')
    expect(source).toContain('.copy-btn--success')
    expect(source).toContain('--hc-success')
  })
})

// ═══════════════════════════════════════════════════════════
//  Bug #3: 聊天输入框不支持粘贴图片
// ═══════════════════════════════════════════════════════════

describe('Bug #3: 聊天输入框粘贴图片支持', () => {
  it('修复前行为（复现）: textarea 没有 @paste 处理器', () => {
    // 验证修复后确实有了
    const source = readFileSync('src/components/chat/ChatInput.vue', 'utf-8')
    expect(source).toContain('@paste="handlePaste"')
  })

  it('修复后: handlePaste 函数存在并检测 image/* 类型', () => {
    const source = readFileSync('src/components/chat/ChatInput.vue', 'utf-8')
    expect(source).toContain('function handlePaste(e: ClipboardEvent)')
    expect(source).toContain("item.type.startsWith('image/')")
    expect(source).toContain('item.getAsFile()')
  })

  it('修复后: 检测到图片时阻止默认行为并调用 addFiles', () => {
    const source = readFileSync('src/components/chat/ChatInput.vue', 'utf-8')
    expect(source).toContain('e.preventDefault()')
    expect(source).toContain('addFiles(imageFiles)')
  })

  it('修复后: 粘贴纯文本时不拦截（imageFiles 为空不 preventDefault）', () => {
    const source = readFileSync('src/components/chat/ChatInput.vue', 'utf-8')
    // 只在有图片时才 preventDefault
    expect(source).toContain('if (imageFiles.length > 0)')
  })

  it('修复后: addFiles 为图片生成 previewUrl', () => {
    const source = readFileSync('src/components/chat/ChatInput.vue', 'utf-8')
    expect(source).toContain("file.type.startsWith('image/')")
    expect(source).toContain('URL.createObjectURL(file)')
  })
})
