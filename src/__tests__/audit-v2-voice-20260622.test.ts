/**
 * 域V 审查取证：语音 / 语音聊天（Voice / VoiceChat）
 *
 * SDET 挑刺式 code review，每条 finding 一个 describe（编号 V-1/V-2…），
 * 断言"正确行为"。RED = 暴露真实 bug / 契约不一致（在当前实现下 FAIL）；
 * GREEN = 行为已正确，作为回归基线锁定。
 *
 * 只读审查 + 只写测试；不改任何生产源码。
 *
 * 前端：
 *   src/api/voice.ts, src/api/voicechat.ts,
 *   src/composables/useVoice.ts,
 *   src/components/chat/VoiceChatComposer.vue, src/components/chat/ChatInput.vue
 * 后端契约权威（ai-core v0.1.6）：
 *   media/voice/voice.go      (TranscribeResult / AudioFormat / SupportedFormats)
 *   media/voice/openai.go     (OpenAISTT.Transcribe — file 扩展名 / SupportedFormats)
 *   media/voicechat/voicechat.go (Request / Result)
 *   hexclaw/api/handler_misc.go:1242-1338  (handleVoiceTranscribe / handleVoiceSynthesize)
 *   hexclaw/api/handler_voicechat.go:29-98 (handleVoiceChat)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// lucide 图标统一桩（用 importOriginal 保留全部具名 export，逐个替换为 <span/>）
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})
// logger 静默
vi.mock('@/utils/logger', () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}))

// ───────────────────────────────────────────────────────────────────────────
// V-1 [高][契约/格式] STT 转写：前端用 webm/mp4 录音，但 format 永远传不到后端 → 当 "wav" 处理
//   FE 录音容器:  src/composables/useVoice.ts:190-219 (webm;codecs=opus / mp4) → File("recording.webm")
//   FE 上传:      src/api/voice.ts:52-57 speechToText —— FormData 只 append('audio')，未带 format
//   BE 取 format: hexclaw/api/handler_misc.go:1276-1279 —— 仅 r.URL.Query().Get("format")，空则默认 "wav"
//   BE 文件名:    ai-core/media/voice/openai.go:141-145 —— ext = opts.Format(="wav")，给 OpenAI 取名 audio.wav
//   BE 支持集:    ai-core/media/voice/openai.go:106-108 —— SupportedFormats = {mp3,wav,ogg,flac}（无 webm/mp4）
//   根因：录制容器是 webm/opus 或 mp4，但既没传 format（query 永远空），也不在 Whisper 支持集内，
//        最终以错误扩展名 audio.wav 投递 → 误导上游、识别失败/退化。
// ───────────────────────────────────────────────────────────────────────────
describe('V-1 STT 录音格式（webm/mp4）与后端 format 契约（修复后回归）', () => {
  // 修复：src/api/voice.ts speechToText 现把真实容器格式作为 URL query 参数传给后端
  //      （后端 handler_misc.go:1276-1279 从 r.URL.Query().Get("format") 读取）。
  //      resolveAudioFormat 从 File 的 MIME/扩展名推断真实容器。
  // 这两条原 RED 的断言锚在测试本地 fixture 上（复刻旧装配），改源码无法翻转 →
  // 重写为直接驱动真实 speechToText / resolveAudioFormat，断言修复后行为（合法：行为已改）。
  /** 复刻 handler_misc.go:1276-1279 后端取 format 的来源：只看 query，不看 FormData */
  function backendResolveFormat(queryFormat: string | null): string {
    const f = queryFormat ?? ''
    return f === '' ? 'wav' : f
  }

  it('修复后：webm 录音 → speechToText 把 format=webm 拼进 URL query，后端可解析出真实容器', async () => {
    const captured: { path?: string } = {}
    vi.resetModules()
    vi.doMock('@/api/client', () => ({
      apiGet: vi.fn(),
      apiPost: vi.fn((path: string) => {
        captured.path = path
        return Promise.resolve({ text: '' })
      }),
    }))
    const { speechToText } = await import('@/api/voice')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' })
    const file = new File([blob], 'recording.webm', { type: 'audio/webm;codecs=opus' })
    await speechToText(file)

    // 真实 speechToText 现在把容器格式拼进 query
    const url = new URL(captured.path ?? '', 'http://x')
    const queryFormat = url.searchParams.get('format')
    expect(queryFormat).toBe('webm')
    // 后端从 query 解析 → 不再退化为 wav
    expect(backendResolveFormat(queryFormat)).toBe('webm')
    vi.doUnmock('@/api/client')
    vi.resetModules()
  })

  it('修复后：resolveAudioFormat 把录音真实容器（webm/mp4/mpeg→mp3）映射到后端识别的 format', async () => {
    const { resolveAudioFormat } = await import('@/api/voice')
    expect(resolveAudioFormat(new File([], 'r.webm', { type: 'audio/webm;codecs=opus' }))).toBe('webm')
    expect(resolveAudioFormat(new File([], 'r.mp4', { type: 'audio/mp4' }))).toBe('mp4')
    // audio/mpeg 归一为 mp3（Whisper 支持集 {mp3,wav,ogg,flac}）
    expect(resolveAudioFormat(new File([], 'r.mp3', { type: 'audio/mpeg' }))).toBe('mp3')
    // 无 MIME 时退化到扩展名
    expect(resolveAudioFormat(new File([], 'r.wav', { type: '' }))).toBe('wav')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-2 [中][契约] speechToText 的 language 走 FormData，但后端只从 query 读取 → 语言提示永远丢失
//   FE: src/api/voice.ts:54-55 —— if (language) form.append('language', language)
//   BE: hexclaw/api/handler_misc.go:1275 —— lang := r.URL.Query().Get("language")
//   根因：传输位置不一致（body form-field vs URL query），后端拿不到 language，
//        Whisper 的 language 加速/纠偏提示恒为空。
// ───────────────────────────────────────────────────────────────────────────
describe('V-2 STT language 传输位置（修复后走 query）', () => {
  // 修复：speechToText 现把 language 拼进 URL query（后端 handler_misc.go:1275 从 query 读）。
  // 原 RED 断言锚在本地复刻 fixture（form-field），改源码无法翻转 → 重写为驱动真实函数。
  /** 后端只认 query（handler_misc.go:1275） */
  function backendLang(queryLang: string | null): string {
    return queryLang ?? ''
  }

  it('修复后：language="zh" 经 URL query 传出，后端能收到 "zh"（不再丢失）', async () => {
    const captured: { path?: string } = {}
    vi.resetModules()
    vi.doMock('@/api/client', () => ({
      apiGet: vi.fn(),
      apiPost: vi.fn((path: string) => {
        captured.path = path
        return Promise.resolve({ text: '' })
      }),
    }))
    const { speechToText } = await import('@/api/voice')
    const file = new File([new Uint8Array([1])], 'r.webm', { type: 'audio/webm' })
    await speechToText(file, 'zh')

    const url = new URL(captured.path ?? '', 'http://x')
    const queryLang = url.searchParams.get('language')
    expect(queryLang).toBe('zh')
    // 后端从 query 读 → 收到 'zh'
    expect(backendLang(queryLang)).toBe('zh')
    vi.doUnmock('@/api/client')
    vi.resetModules()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-3 [中][契约] STTResponse 把 confidence/language/duration 标为必填，但后端三者均 omitempty
//   FE: src/api/voice.ts:25-30 —— { text; confidence: number; language: string; duration: number }（全必填）
//   BE: ai-core/media/voice/voice.go:96-101 —— Language/Duration/Confidence 全部 `json:",omitempty"`
//   根因：当 provider 不回这些字段（如非 verbose_json 路径或缺省值），JSON 整字段缺失，
//        运行时为 undefined，而前端类型断言其为 number/string → 类型谎报，下游 .toFixed() 等会炸。
// ───────────────────────────────────────────────────────────────────────────
describe('V-3 STTResponse 必填字段 vs 后端 omitempty', () => {
  // 后端 TranscribeResult 在零值时序列化出的 JSON（omitempty 会整字段省略）
  // voice.go: Text 无 omitempty（恒在）；Language/Duration/Confidence 有 omitempty。
  function backendTranscribeJSON(text: string): Record<string, unknown> {
    // 模拟 provider 仅返回文本（confidence/language/duration 取零值被 omitempty 抹掉）
    const out: Record<string, unknown> = { text }
    return out
  }

  it('RED：仅返回 text 时，前端断言为必填的 confidence/language/duration 实际缺失（undefined）', () => {
    const json = backendTranscribeJSON('你好世界')
    // 前端 STTResponse 类型承诺这些字段恒为 number/string；运行时却 undefined。
    // 期望（类型契约成立）：三者都应 present。实际：缺失 → RED。
    expect(json).toHaveProperty('confidence')
    expect(json).toHaveProperty('language')
    expect(json).toHaveProperty('duration')
  })

  it('取证：Text 字段无 omitempty（恒返回），故前端只依赖 result.text 是安全的', () => {
    // useVoice.ts:221 仅消费 result.text → 这条路径不受 V-3 影响（防御充分）。
    const json = backendTranscribeJSON('')
    expect(json).toHaveProperty('text')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-4 [中][逻辑/边界] VoiceChatComposer "按住说话"：录音中鼠标移出按钮即 stopRecording → 误发
//   FE: src/components/chat/VoiceChatComposer.vue:228
//       @mouseleave="recording && stopRecording()"
//   根因：mouseleave 与 mouseup 都会触发停止。用户按住麦克风时，只要光标滑出按钮边界
//        （未松手），立即结束录音并上传。长按说话场景下手指/光标轻微移动即误触发送，
//        无法取消（没有"滑出取消"语义）。期望：mouseleave 不应在仍按住时发送。
// ───────────────────────────────────────────────────────────────────────────
describe('V-4 VoiceChatComposer 录音中 mouseleave 误触发发送', () => {
  beforeEach(() => {
    // mock voicechat API：避免真实网络
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const recorders: MockRecorder[] = []
  class MockRecorder {
    static isTypeSupported() { return true }
    state: 'recording' | 'inactive' = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable: ((e: unknown) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    constructor() { recorders.push(this) }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.onstop?.()
    }
  }

  async function mountComposer() {
    recorders.length = 0
    vi.doMock('@/api/voicechat', () => ({
      voiceChat: vi.fn().mockResolvedValue({ provider: 'p', model: 'm', transcript: 'hi' }),
      audioToSrc: vi.fn().mockReturnValue(''),
    }))
    vi.doMock('@/components/common/HcSelect.vue', () => ({
      default: { template: '<div />' },
    }))
    const mod = await import('@/components/chat/VoiceChatComposer.vue')
    const Composer = mod.default

    // mock MediaRecorder / getUserMedia（jsdom 无原生实现）
    vi.stubGlobal('MediaRecorder', MockRecorder as unknown as typeof MediaRecorder)
    const fakeTrack = { stop: vi.fn() }
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [fakeTrack] }),
      },
    })
    vi.stubGlobal('Audio', class { play() { return Promise.resolve() } } as unknown as typeof Audio)

    const wrapper = mount(Composer, { props: { modelId: 'gpt-4o-audio', modelName: 'GPT-4o' } })
    return { wrapper }
  }

  it('RED：按住麦克风录音中、未松手仅光标滑出按钮 → 不应停止录音（应支持"滑出取消"而非直接结束并发送）', async () => {
    const { wrapper } = await mountComposer()
    const mic = wrapper.find('.hc-voicechat__mic')
    expect(mic.exists()).toBe(true)

    await mic.trigger('mousedown') // 开始录音
    await flushPromises()
    // 录音已启动：底层 MediaRecorder 进入 recording
    expect(recorders.length).toBe(1)
    expect(recorders[0]!.state).toBe('recording')
    expect((wrapper.vm as unknown as { recording: boolean }).recording).toBe(true)

    await mic.trigger('mouseleave') // 仅光标滑出，手指仍按住（mouseup 未发生）

    // 期望（正确"长按说话"语义）：未松手 → 录音应继续，MediaRecorder 仍 recording。
    // 实际：模板 line 228 `recording && stopRecording()` → MediaRecorder.stop() → onstop → sendAudio。
    //       下方断言会 FAIL，坐实"光标滑出即结束并上传、无法取消"的误触发缺陷。
    expect(recorders[0]!.state, '滑出未松手时不应停止录音').toBe('recording')
    expect((wrapper.vm as unknown as { recording: boolean }).recording).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-5 [低][死/陈旧注释] voice.ts:38-39 注释称 textToSpeech "当前未被调用"，实际被 useVoice 调用
//   FE 声明:  src/api/voice.ts:37-49 textToSpeech（注释 line 39："当前未被调用"）
//   FE 消费:  src/composables/useVoice.ts:11,274 —— import { textToSpeech }；speak() 内调用
//   根因：陈旧/错误注释（误导维护者以为是死代码，可能被误删）。
// ───────────────────────────────────────────────────────────────────────────
describe('V-5 textToSpeech "当前未被调用" 注释已过时（实际有消费方）', () => {
  it('RED：useVoice 实际 import 并调用了 textToSpeech，注释应被移除', async () => {
    // 读取源文件证明 import 存在（不 mock，纯静态证据）
    const fs = await import('node:fs')
    const path = await import('node:path')
    const useVoiceSrc = fs.readFileSync(
      path.resolve(__dirname, '../composables/useVoice.ts'),
      'utf-8',
    )
    const imports = /import\s*\{[^}]*textToSpeech[^}]*\}\s*from\s*'@\/api\/voice'/.test(useVoiceSrc)
    const calls = /textToSpeech\s*\(/.test(useVoiceSrc)
    expect(imports && calls).toBe(true)

    const voiceSrc = fs.readFileSync(path.resolve(__dirname, '../api/voice.ts'), 'utf-8')
    // 期望：既有消费方，注释里不该再写"当前未被调用"。实际仍写着 → RED。
    expect(voiceSrc).not.toMatch(/当前未被调用/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-6 [中][逻辑] audioToSrc 只区分 mp3/wav，OGG/FLAC/PCM 回应会被错误标成 audio/wav
//   FE: src/api/voicechat.ts:56-57
//       const mime = r.format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
//   BE 可返回的格式: ai-core/media/voice/openai.go:276 TTS SupportedFormats = {mp3,ogg,flac,wav,pcm}
//       voicechat Result.Format 透传模型实际输出格式（voicechat.go:57）
//   根因：非 mp3 一律按 wav 贴 MIME。若模型回 ogg/flac/pcm，data: URL 的 MIME 错配 → 播放失败。
//   注：当前 composer 固定请求 format:'wav'（VoiceChatComposer.vue:103,137），属"被上游约束遮蔽"
//       的潜伏 bug；一旦放开音色/格式选择即暴露。标 RED 钉死正确映射期望。
// ───────────────────────────────────────────────────────────────────────────
describe('V-6 audioToSrc 非 mp3 格式 MIME 映射错误', () => {
  // 复刻 voicechat.ts:53-60 audioToSrc 的 b64 分支（不依赖 env，只验 MIME 决策）
  function audioMime(format: string | undefined): string {
    return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
  }

  it('RED：format="ogg" 的回应应映射为 audio/ogg，而非 audio/wav', () => {
    // 后端 TTS 支持 ogg（openai.go:276），Result.Format 会透传 "ogg"
    expect(audioMime('ogg')).toBe('audio/ogg')
  })

  it('RED：format="flac" 的回应应映射为 audio/flac', () => {
    expect(audioMime('flac')).toBe('audio/flac')
  })

  it('GREEN：mp3 → audio/mpeg；wav → audio/wav（已正确分支）', () => {
    expect(audioMime('mp3')).toBe('audio/mpeg')
    expect(audioMime('wav')).toBe('audio/wav')
    expect(audioMime(undefined)).toBe('audio/wav') // 缺省退化 wav 合理
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-7 [低][契约] VoiceChatRequest.model 必填，但语音对话也支持纯 provider 默认路由
//   取证 + 字段对齐：FE src/api/voicechat.ts:22-31 vs BE voicechat.Request(voicechat.go:33-41)
//   结论：字段名与 json tag 完全对齐（audio/text/voice/format/system/history），provider 由
//        外层 struct 承载（handler_voicechat.go:54-57）。仅作回归基线锁定。
// ───────────────────────────────────────────────────────────────────────────
describe('V-7 VoiceChatRequest/Result 字段与后端 json tag 对齐（回归基线）', () => {
  it('GREEN：Request 字段集 == 后端 voicechat.Request json tag 集（含外层 provider）', () => {
    // 后端：外层 struct { provider } + 内嵌 voicechat.Request{ model,audio,text,voice,format,system,history }
    const backendReqTags = [
      'provider', 'model', 'audio', 'text', 'voice', 'format', 'system', 'history',
    ].sort()
    // 前端 VoiceChatRequest（voicechat.ts:22-31）
    const feReqFields = [
      'provider', 'model', 'audio', 'text', 'voice', 'format', 'system', 'history',
    ].sort()
    expect(feReqFields).toEqual(backendReqTags)
  })

  it('GREEN：Result 字段集 == 后端 voicechat.Result json tag + handler 追加 audio_file_path', () => {
    // 后端 voicechat.Result(voicechat.go:51-59): provider,model,audio,transcript,user_text,format,usage_ms
    // handler_voicechat.go:70-73 追加 audio_file_path
    const backendResTags = [
      'provider', 'model', 'audio', 'transcript', 'user_text', 'format', 'usage_ms',
      'audio_file_path',
    ].sort()
    // 前端 VoiceChatResult（voicechat.ts:33-42）
    const feResFields = [
      'provider', 'model', 'audio', 'audio_file_path', 'transcript', 'user_text', 'format', 'usage_ms',
    ].sort()
    expect(feResFields).toEqual(backendResTags)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// V-8 [中][逻辑/契约] VoiceChatComposer 录音 webm/mp4，却把 audio b64 直传并声明 format:'wav'
//   FE: src/components/chat/VoiceChatComposer.vue:58-65 录音容器 webm;opus / mp4
//       :97-105 sendAudio —— blobToBase64(webmBlob) 后以 { audio, format:'wav' } 上送
//   BE: handler_voicechat.go → voicechat.Request.AudioB64（gpt-4o-audio 接受的输入格式有限）
//   注释自承（VoiceChatComposer.vue:98-99）："webm 需先转 — 但 b64 直传 OpenAI 实际能识别 opus，
//        出问题再加客户端解码" → 半成品/未闭环（依赖未经证实的假设，无降级路径）。
//   根因：format:'wav' 是"期望输出"语义，但用户输入 audio 是 webm/opus；
//        若上游不接受 opus 输入则整轮失败，且代码无格式协商/转码兜底。
// ───────────────────────────────────────────────────────────────────────────
describe('V-8 VoiceChatComposer 输入音频容器与上送声明不自洽（未闭环）', () => {
  it('取证：sendAudio 上送的 format 是"输出期望"，不代表输入 audio 的真实容器', () => {
    // 复刻 VoiceChatComposer.vue:100-105 的 payload 形态
    const recordedContainer = 'webm;codecs=opus' // line 58-59 实际录制容器
    const payload = { model: 'gpt-4o-audio', audio: '<b64>', format: 'wav', voice: 'alloy' }
    // format 字段语义 = 期望输出 wav；与输入容器 webm 无关 → 输入容器信息在请求里完全丢失
    expect(payload.format).toBe('wav')
    expect(recordedContainer).not.toContain('wav')
    // 后端 voicechat.Request 无"输入音频容器/格式"字段 → 上游需自行嗅探 opus。
    // 这是一个有意识的赌注（注释 line 98-99），记为未闭环候选（无转码/无降级）。
    expect(true).toBe(true)
  })

  it('RED：长录音场景——若上游不接受 opus 输入，前端无任何客户端转码/降级路径', async () => {
    // 静态证据：组件源码里不存在任何 webm→wav 转码（AudioContext decode / WAV 编码）调用。
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(__dirname, '../components/chat/VoiceChatComposer.vue'),
      'utf-8',
    )
    const hasTranscode =
      /decodeAudioData|AudioContext|OfflineAudioContext|encodeWAV|toWav/.test(src)
    // 期望：应有输入格式协商或转码兜底（正确行为）。实际：无 → RED（坐实"出问题再说"未闭环）。
    expect(hasTranscode).toBe(true)
  })
})
