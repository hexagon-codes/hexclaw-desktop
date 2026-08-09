/**
 * @deprecated 兼容旧调用方的只读投影。
 * 模型与端点唯一真相源是 PROVIDER_PRESETS；本文件不得再维护手写目录。
 */

import { PROVIDER_LOGOS, PROVIDER_PRESETS } from './providers'
import type { ProviderType } from '@/types'

export interface LLMProvider {
  key: string
  name: string
  logo: string | null
  baseUrl: string
  models: string[]
  note?: string
}

const LEGACY_TYPES: ProviderType[] = [
  'openai',
  'anthropic',
  'deepseek',
  'gemini',
  'zhipu',
  'ark',
  'kimi',
  'ernie',
  'hunyuan',
  'spark',
  'minimax',
  'qwen',
  'custom',
]

export const LLM_PROVIDERS: LLMProvider[] = LEGACY_TYPES.map((type) => {
  const preset = PROVIDER_PRESETS[type]
  return {
    key: type === 'gemini' ? 'google' : type === 'ark' ? 'doubao' : type,
    name: preset.name,
    logo: type === 'custom' ? null : PROVIDER_LOGOS[type],
    baseUrl: preset.defaultBaseUrl,
    models: preset.defaultModels.map((model) => model.id),
  }
})
