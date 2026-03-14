/**
 * LLM Provider 预设配置
 *
 * 定义各 Provider 的默认 Base URL、预设模型列表和 API Key 占位符。
 * 用户添加 Provider 时自动填充这些预设值。
 */

import type { ProviderPreset, ProviderType } from '@/types'

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  openai: {
    type: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    placeholder: 'sk-...',
    defaultModels: [
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', capabilities: ['text', 'vision'] },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', capabilities: ['text', 'vision'] },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', capabilities: ['text'] },
      { id: 'o1', name: 'o1', capabilities: ['text'] },
      { id: 'o1-mini', name: 'o1 Mini', capabilities: ['text'] },
      { id: 'o3-mini', name: 'o3 Mini', capabilities: ['text'] },
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
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', capabilities: ['text', 'vision'] },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', capabilities: ['text', 'vision'] },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', capabilities: ['text', 'vision'] },
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
      { id: 'qwen-max', name: 'Qwen Max', capabilities: ['text'] },
      { id: 'qwen-plus', name: 'Qwen Plus', capabilities: ['text'] },
      { id: 'qwen-turbo', name: 'Qwen Turbo', capabilities: ['text'] },
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
  ollama: {
    type: 'ollama',
    name: 'Ollama (本地)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    placeholder: '无需 API Key',
    defaultModels: [
      { id: 'llama3.1', name: 'Llama 3.1', capabilities: ['text'] },
      { id: 'qwen2.5', name: 'Qwen 2.5', capabilities: ['text'] },
      { id: 'mistral', name: 'Mistral', capabilities: ['text'] },
      { id: 'deepseek-r1', name: 'DeepSeek R1', capabilities: ['text'] },
      { id: 'llava', name: 'LLaVA', capabilities: ['text', 'vision'] },
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
export function getProviderTypes(): ProviderPreset[] {
  return Object.values(PROVIDER_PRESETS)
}
