import { apiGet } from './client'

/** LLM 模型信息 */
export interface LLMModel {
  id: string
  name: string
  provider: string
  context_length?: number
  supports_vision?: boolean
  supports_tools?: boolean
}

/** 获取可用模型列表 */
export function listModels() {
  return apiGet<{ models: LLMModel[] }>('/api/v1/models')
}
