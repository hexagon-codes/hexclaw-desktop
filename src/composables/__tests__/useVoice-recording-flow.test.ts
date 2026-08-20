import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { speechToTextMock, textToSpeechMock } = vi.hoisted(() => ({
  speechToTextMock: vi.fn(),
  textToSpeechMock: vi.fn(),
}))

vi.mock('@/api/voice', () => ({
  speechToText: speechToTextMock,
  textToSpeech: textToSpeechMock,
}))

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)

  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm'
    MockMediaRecorder.instances.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({
      data: new Blob(['voice'], { type: this.mimeType }),
    } as BlobEvent)
    queueMicrotask(() => this.onstop?.())
  }
}

const trackStop = vi.fn()
const getUserMedia = vi.fn(async () => ({
  getTracks: () => [{ stop: trackStop }],
}) as unknown as MediaStream)

beforeEach(() => {
  vi.clearAllMocks()
  MockMediaRecorder.instances = []
  vi.stubGlobal('MediaRecorder', MockMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useVoice · MediaRecorder 整段转写', () => {
  it('确认录音后等待整段转写完成并返回文本', async () => {
    speechToTextMock.mockResolvedValue({ text: '整段转写结果' })
    const { useVoice } = await import('../useVoice')
    const voice = useVoice()

    await voice.startListening()
    expect(voice.isListening.value).toBe(true)

    const text = await voice.finishListening()

    expect(speechToTextMock).toHaveBeenCalledTimes(1)
    expect(text).toBe('整段转写结果')
    expect(voice.transcript.value).toBe('整段转写结果')
    expect(voice.isListening.value).toBe(false)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('取消录音仅丢弃数据，不调用后端转写', async () => {
    const { useVoice } = await import('../useVoice')
    const voice = useVoice()

    await voice.startListening()
    await voice.cancelListening()
    await Promise.resolve()

    expect(speechToTextMock).not.toHaveBeenCalled()
    expect(voice.transcript.value).toBe('')
    expect(voice.isListening.value).toBe(false)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('整段转写失败时返回空文本并写入既有 error ref', async () => {
    speechToTextMock.mockRejectedValue(new Error('Transcribe failed'))
    const { useVoice } = await import('../useVoice')
    const voice = useVoice()

    await voice.startListening()
    const text = await voice.finishListening()

    expect(text).toBe('')
    expect(voice.error.value).toBe('Transcribe failed')
    expect(voice.isListening.value).toBe(false)
  })
})
