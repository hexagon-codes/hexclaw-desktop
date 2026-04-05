import type { AppConfig } from '@/types'

export const CONFIG_STORE_KEY = 'app_config'

export const CONFIG_STORE_FILE = 'config.dat'

export function defaultConfig(): AppConfig {
  return {
    llm: {
      providers: [],
      defaultModel: '',
      defaultProviderId: '',
      routing: {
        enabled: false,
        strategy: 'cost-aware',
      },
    },
    security: {
      gateway_enabled: true,
      injection_detection: true,
      pii_filter: false,
      content_filter: true,
      max_tokens_per_request: 8192,
      rate_limit_rpm: 60,
    },
    general: {
      language: 'zh-CN',
      log_level: 'info',
      data_dir: '',
      auto_start: false,
      defaultAgentRole: '',
    },
    notification: {
      system_enabled: true,
      sound_enabled: false,
      agent_complete: true,
    },
    mcp: {
      default_protocol: 'stdio',
    },
  }
}
