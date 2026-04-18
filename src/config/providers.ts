/**
 * LLM Provider 预设配置
 *
 * 定义各 Provider 的默认 Base URL、预设模型列表和 API Key 占位符。
 * 用户添加 Provider 时自动填充这些预设值。
 */

import type { ModelCapability, ProviderPreset, ProviderType } from '@/types'
import { OLLAMA_BASE } from '@/config/env'

import openaiLogo from '@/assets/provider-logos/openai.svg'
import deepseekLogo from '@/assets/provider-logos/deepseek.svg'
import anthropicLogo from '@/assets/provider-logos/anthropic.svg'
import geminiLogo from '@/assets/provider-logos/gemini.svg'
import qwenLogo from '@/assets/provider-logos/qwen.svg'
import arkLogo from '@/assets/provider-logos/ark.svg'
import zhipuLogo from '@/assets/provider-logos/zhipu.svg'
import kimiLogo from '@/assets/provider-logos/kimi.svg'
import ernieLogo from '@/assets/provider-logos/ernie.svg'
import hunyuanLogo from '@/assets/provider-logos/hunyuan.svg'
import sparkLogo from '@/assets/provider-logos/spark.svg'
import minimaxLogo from '@/assets/provider-logos/minimax.svg'
import ollamaLogo from '@/assets/provider-logos/ollama.svg'
import customLogo from '@/assets/provider-logos/custom.svg'

export const PROVIDER_LOGOS: Record<ProviderType, string> = {
  openai: openaiLogo,
  deepseek: deepseekLogo,
  anthropic: anthropicLogo,
  gemini: geminiLogo,
  qwen: qwenLogo,
  ark: arkLogo,
  zhipu: zhipuLogo,
  kimi: kimiLogo,
  ernie: ernieLogo,
  hunyuan: hunyuanLogo,
  spark: sparkLogo,
  minimax: minimaxLogo,
  ollama: ollamaLogo,
  custom: customLogo,
}

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  openai: {
    type: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'vision'] },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', capabilities: ['text', 'vision'] },
      { id: 'o3', name: 'o3', capabilities: ['text', 'vision'] },
      { id: 'o3-mini', name: 'o3 Mini', capabilities: ['text'] },
      { id: 'o4-mini', name: 'o4 Mini', capabilities: ['text', 'vision'] },
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
    ],
  },
  deepseek: {
    type: 'deepseek',
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', capabilities: ['text'] },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', capabilities: ['text'] },
    ],
  },
  anthropic: {
    type: 'anthropic',
    name: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    placeholder: 'sk-ant-...',
    defaultModels: [
      { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', capabilities: ['text', 'vision'] },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', capabilities: ['text', 'vision'] },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', capabilities: ['text', 'vision'] },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', capabilities: ['text', 'vision'] },
    ],
  },
  gemini: {
    type: 'gemini',
    name: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    placeholder: 'AIza...',
    defaultModels: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', capabilities: ['text', 'vision', 'video', 'audio'] },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: ['text', 'vision', 'video', 'audio'] },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: ['text', 'vision', 'video', 'audio'] },
    ],
  },
  qwen: {
    type: 'qwen',
    name: '通义千问',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'qwen3-235b-a22b', name: 'Qwen3 235B', capabilities: ['text'] },
      { id: 'qwen-max', name: 'Qwen Max', capabilities: ['text'] },
      { id: 'qwen-plus', name: 'Qwen Plus', capabilities: ['text'] },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', capabilities: ['text', 'vision', 'video'] },
    ],
  },
  ark: {
    type: 'ark',
    name: '豆包 (Ark)',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    placeholder: 'ep-...',
    defaultModels: [
      { id: 'doubao-pro-32k', name: 'Doubao Pro 32K', capabilities: ['text'] },
      { id: 'doubao-lite-32k', name: 'Doubao Lite 32K', capabilities: ['text'] },
      { id: 'doubao-vision-pro-32k', name: 'Doubao Vision Pro', capabilities: ['text', 'vision'] },
    ],
  },
  zhipu: {
    type: 'zhipu',
    name: '智谱 AI',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'glm-z1-flash', name: 'GLM-Z1 Flash', capabilities: ['text'] },
      { id: 'glm-z1-airx', name: 'GLM-Z1 AirX', capabilities: ['text'] },
      { id: 'glm-4v-plus', name: 'GLM-4V Plus', capabilities: ['text', 'vision'] },
      { id: 'cogview-4', name: 'CogView-4', capabilities: ['image_generation'] },
      { id: 'cogvideox-2', name: 'CogVideoX-2', capabilities: ['video_generation'] },
    ],
  },
  kimi: {
    type: 'kimi',
    name: 'Kimi (月之暗面)',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'kimi-k2', name: 'Kimi K2', capabilities: ['text'] },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', capabilities: ['text'] },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K', capabilities: ['text'] },
    ],
  },
  ernie: {
    type: 'ernie',
    name: '文心一言 (百度)',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    placeholder: 'bce-v3/...',
    defaultModels: [
      { id: 'ernie-x1-turbo-32k', name: 'ERNIE X1 Turbo', capabilities: ['text'] },
      { id: 'ernie-4.5-8k', name: 'ERNIE 4.5 8K', capabilities: ['text'] },
      { id: 'ernie-4.0-8k', name: 'ERNIE 4.0 8K', capabilities: ['text'] },
    ],
  },
  hunyuan: {
    type: 'hunyuan',
    name: '腾讯混元',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'hunyuan-t1-latest', name: 'Hunyuan T1', capabilities: ['text'] },
      { id: 'hunyuan-pro', name: 'Hunyuan Pro', capabilities: ['text'] },
      { id: 'hunyuan-lite', name: 'Hunyuan Lite', capabilities: ['text'] },
    ],
  },
  spark: {
    type: 'spark',
    name: '讯飞星火',
    defaultBaseUrl: 'https://spark-api-open.xf-yun.com/v1',
    placeholder: 'Bearer ...',
    defaultModels: [
      { id: 'spark-max', name: 'Spark Max', capabilities: ['text'] },
      { id: 'spark-pro', name: 'Spark Pro', capabilities: ['text'] },
      { id: 'spark-lite', name: 'Spark Lite', capabilities: ['text'] },
    ],
  },
  minimax: {
    type: 'minimax',
    name: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    placeholder: 'eyJ...',
    defaultModels: [
      { id: 'MiniMax-M1-80k', name: 'MiniMax M1', capabilities: ['text'] },
      { id: 'abab6.5s-chat', name: 'ABAB 6.5s', capabilities: ['text'] },
    ],
  },
  ollama: {
    type: 'ollama',
    name: 'Ollama (本地)',
    defaultBaseUrl: `${OLLAMA_BASE}/v1`,
    placeholder: '无需 API Key',
    // 关联后由 syncOllamaModels 从 Ollama 实际拉取，ID 带 tag（如 qwen2.5-vl:7b）。
    // 这里的白名单用作能力识别字典：syncOllamaModels 会按 base ID（去掉 :tag）匹配，
    // 命中则沿用这里的 capabilities，否则回退 inferCapabilitiesFromId 正则推断。
    defaultModels: [
      { id: 'qwen2.5-vl', name: 'Qwen 2.5 VL', capabilities: ['text', 'vision'] },
      { id: 'qwen2-vl', name: 'Qwen 2 VL', capabilities: ['text', 'vision'] },
      { id: 'llava', name: 'LLaVA', capabilities: ['text', 'vision'] },
      { id: 'llava-llama3', name: 'LLaVA Llama3', capabilities: ['text', 'vision'] },
      { id: 'llava-phi3', name: 'LLaVA Phi3', capabilities: ['text', 'vision'] },
      { id: 'llama3.2-vision', name: 'Llama 3.2 Vision', capabilities: ['text', 'vision'] },
      { id: 'minicpm-v', name: 'MiniCPM-V', capabilities: ['text', 'vision'] },
      { id: 'moondream', name: 'Moondream', capabilities: ['text', 'vision'] },
      { id: 'bakllava', name: 'BakLLaVA', capabilities: ['text', 'vision'] },
      { id: 'gemma4', name: 'Gemma 4', capabilities: ['text', 'vision'] },
      // 代码专项（同 chat 协议，区别在模型权重）
      { id: 'qwen3-coder', name: 'Qwen3 Coder', capabilities: ['text', 'code'] },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', capabilities: ['text', 'code'] },
      { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2', capabilities: ['text', 'code'] },
      { id: 'codellama', name: 'Code Llama', capabilities: ['text', 'code'] },
      { id: 'codegemma', name: 'CodeGemma', capabilities: ['text', 'code'] },
      { id: 'starcoder2', name: 'StarCoder 2', capabilities: ['text', 'code'] },
      { id: 'granite-code', name: 'Granite Code', capabilities: ['text', 'code'] },
      { id: 'devstral', name: 'Devstral', capabilities: ['text', 'code'] },
    ],
  },
  custom: {
    type: 'custom',
    name: '自定义',
    defaultBaseUrl: '',
    placeholder: 'API Key',
    defaultModels: [],
  },
}

/** 获取所有可添加的 Provider 类型列表 */
export function getProviderTypes(options?: { includeOllama?: boolean }): ProviderPreset[] {
  // 默认情况下 Ollama 由 OllamaCard 统一管理，不在添加服务商选择器中重复
  // 引导页等场景需要显示 Ollama 时传入 includeOllama: true
  if (options?.includeOllama) return Object.values(PROVIDER_PRESETS)
  return Object.values(PROVIDER_PRESETS).filter(p => p.type !== 'ollama')
}

/**
 * 从模型 ID 推断能力（名称兜底）。
 * 用于 Ollama 本地模型 / 云端 Provider 拉取到预设白名单外的模型时，
 * 基于常见模型命名约定自动标记多模态能力。
 *
 * 纯生成类（image_generation / video_generation）单独返回，不带 text。
 */
export function inferCapabilitiesFromId(id: string): ModelCapability[] {
  // 纯图像生成（不做对话）
  if (/cogview|dall-?e|\bflux\b|sdxl|stable-?diffusion|midjourney|imagen|recraft|ideogram|janus/i.test(id)) {
    return ['image_generation']
  }
  // 纯视频生成
  if (/cogvideo|\bsora\b|runway|kling|\bpika\b|hailuo|\bveo\b|vidu/i.test(id)) {
    return ['video_generation']
  }
  const caps: ModelCapability[] = ['text']
  // 视觉理解（vision-language）
  // - Ollama: qwen-vl/qwen2-vl/qwen2.5-vl/qwen3-vl/llava/moondream/minicpm-v/bakllava/gemma4/llama3.2-vision
  // - 云端: glm-4v/glm-4.5v/qwen-vl-max/gpt-4o/gpt-4-vision/claude-3+/gemini-*/internvl/pixtral/molmo/cogvlm/qvq
  if (
    /\bvl\b|vision|llava|moondream|minicpm-v|bakllava|gemma4|pixtral|molmo|internvl|cogvlm|\bqvq\b|glm-?\d+\.?\d*v|gpt-?4o|gpt-?4-?vision|claude-3|claude-sonnet-4|claude-opus-4|claude-haiku-4|gemini-/i.test(id)
  ) {
    caps.push('vision')
  }
  // 音频（TTS / ASR / 语音模型）
  if (/whisper|\btts\b|\basr\b|glm-4-voice|qwen.?audio|gpt-4o-audio/i.test(id)) {
    caps.push('audio')
  }
  // 代码专项（编码强化模型 — 标识用，功能上和普通 chat 同链路，区别只在模型权重）
  // Ollama: qwen3-coder / qwen-coder / deepseek-coder / codellama / codegemma / starcoder / granite-code / devstral
  // 云端: 大多数 Provider 没有专门 code 端点，但 deepseek-coder-v2 / qwen-coder-plus 等也是同名约定
  if (/coder|codellama|codegemma|starcoder|granite-code|devstral|phi-coder|wizardcoder|magicoder/i.test(id)) {
    caps.push('code')
  }
  return caps
}

/**
 * 匹配 Ollama 模型 ID（可带 :tag）到预设白名单的 base ID。
 * 命中则返回预设 capabilities，未命中回退 inferCapabilitiesFromId。
 */
export function resolveOllamaCapabilities(id: string): ModelCapability[] {
  const baseId = id.split(':')[0] ?? id
  const preset = PROVIDER_PRESETS.ollama.defaultModels.find(m => m.id === baseId)
  return preset?.capabilities ?? inferCapabilitiesFromId(id)
}

/**
 * 判断模型能否在聊天页对话使用。
 *
 * 排除两类不可对话的模型：
 *  - 纯生成（image_generation / video_generation）：没有 text 输出
 *  - 纯语音工具（仅 audio，无 text）：whisper / tts-1 等 STT/TTS 服务
 *
 * 多模态对话模型（text + vision / video / audio）= 可对话。
 */
export function isChatModel(capabilities: ModelCapability[] | undefined): boolean {
  const caps = capabilities ?? ['text']
  return caps.includes('text')
}

/** 模型主类型（用于 UI 决定渲染哪种 composer / 是否过滤） */
export type ModelKind = 'chat' | 'image_generator' | 'video_generator' | 'audio_tool'

export function classifyModel(capabilities: ModelCapability[] | undefined): ModelKind {
  const caps = capabilities ?? ['text']
  if (caps.includes('text')) return 'chat'
  if (caps.includes('image_generation')) return 'image_generator'
  if (caps.includes('video_generation')) return 'video_generator'
  if (caps.includes('audio')) return 'audio_tool'
  return 'chat'
}
