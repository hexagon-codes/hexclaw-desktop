import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock apiSSE
const mockApiSSE = vi.fn()
vi.mock('@/api/client', () => ({
  apiSSE: (...args: unknown[]) => mockApiSSE(...args),
}))

// 导入要延迟到 mock 之后
const { useSSE } = await import('../useSSE')

function createMockStream(chunks: string[]): ReadableStream<string> {
  let index = 0
  return new ReadableStream<string>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!)
        index++
      } else {
        controller.close()
      }
    },
  })
}

describe('useSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has correct initial state', () => {
    const { streaming, content, error } = useSSE()
    expect(streaming.value).toBe(false)
    expect(content.value).toBe('')
    expect(error.value).toBeNull()
  })

  it('streams content from SSE', async () => {
    const stream = createMockStream(['{"content":"Hello"}', '{"content":" World"}'])
    mockApiSSE.mockResolvedValue(stream)

    const { start, content, streaming } = useSSE()
    await start('/api/chat', { message: 'hi' })

    expect(content.value).toBe('Hello World')
    expect(streaming.value).toBe(false)
  })

  it('calls onChunk callback', async () => {
    const stream = createMockStream(['{"content":"A"}', '{"content":"B"}'])
    mockApiSSE.mockResolvedValue(stream)

    const chunks: string[] = []
    const { start } = useSSE()
    await start('/api/chat', { message: 'hi' }, (chunk) => chunks.push(chunk))

    expect(chunks).toEqual(['A', 'B'])
  })

  it('calls onDone callback with full content', async () => {
    const stream = createMockStream(['{"content":"Hello"}'])
    mockApiSSE.mockResolvedValue(stream)

    let doneContent = ''
    const { start } = useSSE()
    await start('/api/chat', {}, undefined, (full) => { doneContent = full })

    expect(doneContent).toBe('Hello')
  })

  it('handles non-JSON chunks', async () => {
    const stream = createMockStream(['plain text'])
    mockApiSSE.mockResolvedValue(stream)

    const { start, content } = useSSE()
    await start('/api/chat', {})

    expect(content.value).toBe('plain text')
  })

  it('handles API errors', async () => {
    mockApiSSE.mockRejectedValue(new Error('Network error'))

    const { start, error, streaming } = useSSE()
    await start('/api/chat', {})

    expect(error.value).toContain('Network error')
    expect(streaming.value).toBe(false)
  })

  it('stop cancels the reader', async () => {
    // 创建一个不会自动结束的流
    let controller: ReadableStreamDefaultController<string>
    const stream = new ReadableStream<string>({
      start(c) { controller = c },
    })
    mockApiSSE.mockResolvedValue(stream)

    const { start, stop, streaming } = useSSE()
    const promise = start('/api/chat', {})

    // 给 start 一点时间开始
    await new Promise(r => setTimeout(r, 10))

    stop()
    expect(streaming.value).toBe(false)

    // 等待 start 完成（因为 reader 被 cancel）
    await promise
  })
})
