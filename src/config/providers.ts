/**
 * LLM Provider 预设配置
 *
 * 定义各 Provider 的默认 Base URL、预设模型列表和 API Key 占位符。
 * 用户添加 Provider 时自动填充这些预设值。
 */

import type { ProviderPreset, ProviderType } from '@/types'

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
    defaultBaseUrl: 'http://localhost:11434/v1',
    placeholder: '无需 API Key',
    defaultModels: [], // 关联后由 syncOllamaModels 从 Ollama 实际模型列表同步
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
