/**
 * 全生态契约挑刺审计（2026-06-22）—— 前端 hexclaw-desktop ↔ 后端 hexclaw/ai-core 对齐。
 *
 * 这些是 **RED 暴露测试**：每条断言当前会失败，钉死一个已用双端源码核实的 bug。
 * 修复前保持 RED（证据），修复后转 GREEN 回归锁。不在本次会话修复（仅暴露）。
 *
 * 证据均经 desktop + backend 双端源码逐行核对（非 agent 猜测）：
 *
 *   AUD-1 [P0][功能未闭环] cron 投递到 IM/连接目标全链路断裂
 *         desktop createCronJobJSON 永不发 chat_id；后端 Deliverer 在空 ChatID 时硬失败。
 *         证据：src/api/tasks.ts:272-292（draft 无 chat_id）
 *               + hexclaw/cmd/hexclaw/main.go:1341 `if job.ChatID == "" { return fmt.Errorf("...has no chat_id for IM target...") }`
 *               + src/views/TasksView.vue:48 deliver 下拉含 feishu/discord/wechat + 连接实例，但表单无 chat_id 采集。
 *
 *   AUD-2 [P1][逻辑错误] webhook 类型词表前后端不一致
 *         desktop 发 wecom/feishu/dingtalk/custom；后端只认 generic/github/gitlab。
 *         证据：src/api/webhook.ts:5 + hexclaw/webhook/webhook.go:40-42。
 *
 *   AUD-3 [P1][功能未闭环] webhook 真实 URL 永不展示 + 渲染后端不返回的 url/events
 *         后端 Webhook 结构无 url/events，真实 URL 是服务端按 name 生成的 /api/v1/webhooks/{name}；
 *         WebhookPanel 绑定 wh.url / wh.events（恒 undefined）→ 用户拿不到可用的 webhook URL。
 *         证据：hexclaw/webhook/webhook.go:46-59（无 url/events）
 *               + src/components/automation/WebhookPanel.vue:245 `{{ wh.url }}` / :247 `v-for ev in wh.events`。
 *
 *   AUD-4 [P1][逻辑错误] voicechat 输入音频容器被错标为输出格式
 *         前端录 webm/opus，却发 format:'wav'；ai-core 用同一 format 作 input_audio.format。
 *         OpenAI input_audio 只收 wav/mp3 → 语音输入对话必失败。
 *         证据：src/components/chat/VoiceChatComposer.vue:59-66(录 webm)/:117(发 'wav')
 *               + ai-core/media/voicechat/openai.go:128-130,152（同一 format 喂 input_audio）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')

const calls = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), del: vi.fn() }))
vi.mock('@/api/client', () => ({
  apiPost: (...a: unknown[]) => calls.post(...a),
  apiGet: (...a: unknown[]) => calls.get(...a),
  apiDelete: (...a: unknown[]) => calls.del(...a),
}))

describe('AUD-1 [P0] cron 投递到 IM/连接目标缺 chat_id（后端 Deliverer 必失败）', () => {
  beforeEach(() => {
    calls.post.mockReset()
    calls.post.mockResolvedValue({ job: { id: 'j1', spec: {} } })
  })

  it('IM 投递目标的 chat_id 必须透传进 draft（后端 Deliverer 需要）', async () => {
    const { createCronJobJSON } = await import('@/api/tasks')
    await createCronJobJSON({ name: '日报', schedule: '0 9 * * *', prompt: '汇总', deliver: ['feishu'], chat_id: 'oc_123' })
    const body = calls.post.mock.calls[0]![1] as { draft: Record<string, unknown> }
    // 后端 cmd/hexclaw/main.go:1341：IM 目标且 ChatID 为空 → "has no chat_id for IM target" 投递失败。
    // 修复后 createCronJobJSON 把 input.chat_id 透传进 draft.chat_id；后端 CronJobDraft 解析它落到 job.ChatID。
    expect(body.draft.chat_id, 'chat_id 必须透传进 draft 供后端落到 job.ChatID').toBe('oc_123')
  })
})

describe('AUD-2 [P1] webhook 类型词表前后端不一致', () => {
  beforeEach(() => {
    calls.post.mockReset()
    calls.post.mockResolvedValue({ id: 'w1', name: 'h', url: '' })
  })

  it('createWebhook 发送的 type 必须是后端认识的类型(generic/github/gitlab)', async () => {
    const { createWebhook } = await import('@/api/webhook')
    await createWebhook({ name: 'h', type: 'github', prompt: '汇总事件' })
    const body = calls.post.mock.calls[0]![1] as { type: string; prompt: string }
    // 后端 webhook/webhook.go:40-42 仅 generic/github/gitlab。修复后前端词表已对齐。
    const BACKEND_WEBHOOK_TYPES = ['generic', 'github', 'gitlab']
    expect(BACKEND_WEBHOOK_TYPES, `前端 webhook type 不在后端词表内：${body.type}`).toContain(body.type)
    expect(body.prompt, '后端要求 prompt 非空').toBeTruthy()
  })
})

describe('AUD-3 [P1] webhook 真实 URL 永不展示（绑定后端不返回的 wh.url/wh.events）', () => {
  it('WebhookPanel 列表项展示据 name 派生的真实 URL，不绑定后端不返回的 wh.url', () => {
    const panel = read('components/automation/WebhookPanel.vue')
    // 后端 Webhook 结构无 url（webhook.go:46-59）；真实 URL = /api/v1/webhooks/{name} 服务端生成。
    expect(panel, '不应绑定恒为 undefined 的 wh.url').not.toMatch(/\{\{\s*wh\.url\s*\}\}/)
    expect(panel, '应据 name 派生真实 webhook URL 展示').toMatch(/webhookUrlFor\(wh\.name\)/)
  })

  it('WebhookPanel 不应渲染后端结构里不存在的 wh.events 标签', () => {
    const panel = read('components/automation/WebhookPanel.vue')
    // 后端 Webhook 无 events 字段 → v-for ev in wh.events 恒空。
    expect(panel, 'wh.events 后端不返回，渲染恒空，应移除或改为后端实有字段')
      .not.toMatch(/v-for="ev in wh\.events"/)
  })
})

describe('AUD-4 [P1] voicechat 录制音频上送前转码为 WAV（使 format:wav 真实）', () => {
  it('提供 WAV 转码工具（解码 + 重编码 16-bit PCM）', () => {
    const util = read('utils/audio-wav.ts')
    // OpenAI input_audio 只收 wav/mp3；录制是 webm/opus。需前端解码后重编码 WAV。
    expect(util).toMatch(/decodeAudioData/)
    expect(util).toMatch(/RIFF/) // WAV 头
    expect(util).toMatch(/export async function audioBlobToWavBase64/)
  })

  it('VoiceChatComposer 录音上送前调用 WAV 转码（不再 webm 字节贴 wav 标签）', () => {
    const comp = read('components/chat/VoiceChatComposer.vue')
    // 修复后：sendAudio 先 audioBlobToWavBase64(blob) 再发 format:'wav'，字节与声明一致。
    expect(comp, 'sendAudio 应先把录音转码为 WAV').toMatch(/audioBlobToWavBase64\s*\(/)
  })
})
