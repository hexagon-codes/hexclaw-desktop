/** LLM 模型信息 */
export interface LLMModel {
  id: string
  name: string
  provider: string
  context_length?: number
  supports_vision?: boolean
  supports_tools?: boolean
}
