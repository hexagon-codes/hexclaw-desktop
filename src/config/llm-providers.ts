/**
 * LLM 服务商预置目录
 *
 * 用于 SettingsView / WelcomeView 的服务商选择器。
 * 选择后自动填入 baseUrl 和默认模型列表，用户只需填 API Key。
 */

export interface LLMProvider {
  key: string
  name: string
  logo: string | null
  baseUrl: string
  models: string[]
  note?: string
}

export const LLM_PROVIDERS: LLMProvider[] = [
  // === International ===
  { key: 'openai', name: 'OpenAI', logo: '/logos/openai.svg', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
  { key: 'anthropic', name: 'Anthropic', logo: '/logos/anthropic.svg', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'] },
  { key: 'deepseek', name: 'DeepSeek', logo: '/logos/deepseek.svg', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'google', name: 'Google Gemini', logo: '/logos/gemini.svg', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },

  // === China ===
  { key: 'zhipu', name: '智谱 AI', logo: '/logos/zhipu.svg', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash', 'glm-4v-plus'] },
  { key: 'doubao', name: '豆包 (字节)', logo: '/logos/doubao.svg', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-256k', 'doubao-lite-128k', 'seed-1.6-thinking'] },
  { key: 'kimi', name: 'Kimi (月之暗面)', logo: '/logos/kimi.svg', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-128k', 'moonshot-v1-32k'] },
  { key: 'ernie', name: '文心一言 (百度)', logo: '/logos/ernie.svg', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', models: ['ernie-4.5-8k', 'ernie-4.0-8k', 'ernie-x1'], note: '需适配百度自有 API 格式' },
  { key: 'hunyuan', name: '腾讯混元', logo: '/logos/hunyuan.svg', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-pro', 'hunyuan-standard', 'hunyuan-lite'] },
  { key: 'spark', name: '讯飞星火', logo: '/logos/spark.svg', baseUrl: 'https://spark-api-open.xf-yun.com/v1', models: ['spark-max', 'spark-pro', 'spark-lite'], note: 'v3.5+ 已支持 OpenAI 兼容格式' },
  { key: 'minimax', name: 'MiniMax', logo: '/logos/minimax.svg', baseUrl: 'https://api.minimax.chat/v1', models: ['abab6.5s-chat', 'abab5.5-chat'] },
  { key: 'qwen', name: '通义千问 (阿里)', logo: '/logos/qwen.svg', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-32b'] },

  // === Local ===
  // Ollama 由 OllamaCard 统一管理（内嵌引擎 + 自动检测），不在添加服务商列表中重复
  { key: 'custom', name: '自定义 (OpenAI 兼容)', logo: null, baseUrl: '', models: [] },
]
