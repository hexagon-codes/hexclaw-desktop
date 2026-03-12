import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getConfig, updateConfig } from '@/api/settings'
import { trySafe } from '@/utils/errors'
import { saveSecureValue, loadSecureValue } from '@/utils/secure-store'
import { logger } from '@/utils/logger'
import type { AppConfig, ApiError } from '@/types'

/** 安全存储中 API Key 的键名 */
const API_KEY_STORE_KEY = 'llm_api_key'

/** 用于发送到后端的掩码值 (隐藏真实密钥) */
const MASKED_KEY = '********'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  /** 加载配置 — 从后端获取配置，从安全存储恢复 API Key */
  async function loadConfig() {
    loading.value = true
    error.value = null
    const [res, err] = await trySafe(() => getConfig(), '加载配置')
    if (res) {
      config.value = res
    } else {
      // 后端不可达时使用默认配置
      config.value = {
        llm: {
          provider: 'openai',
          model: 'gpt-4o',
          api_key: '',
          temperature: 0.7,
          max_tokens: 4096,
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
        },
      }
    }

    // 从安全存储恢复 API Key
    try {
      const secureKey = await loadSecureValue(API_KEY_STORE_KEY)
      if (secureKey && config.value) {
        config.value.llm.api_key = secureKey
        logger.debug('API Key 已从安全存储恢复')
      }
    } catch (e) {
      logger.warn('加载安全存储 API Key 失败', e)
    }

    error.value = err
    loading.value = false
  }

  /** 保存配置 — API Key 存入安全存储，后端只接收掩码值 */
  async function saveConfig(newConfig: AppConfig) {
    // 提取 API Key 并安全存储
    const apiKey = newConfig.llm.api_key
    if (apiKey && apiKey !== MASKED_KEY) {
      try {
        await saveSecureValue(API_KEY_STORE_KEY, apiKey)
        logger.debug('API Key 已安全存储')
      } catch (e) {
        logger.warn('API Key 安全存储失败', e)
      }
    }

    // 发送到后端时用掩码替换真实 API Key
    const configForBackend: AppConfig = {
      ...newConfig,
      llm: {
        ...newConfig.llm,
        api_key: apiKey ? MASKED_KEY : '',
      },
    }

    const [res, err] = await trySafe(() => updateConfig(configForBackend), '保存配置')
    if (res) {
      // 后端返回的配置中 api_key 是掩码，需要还原为真实值
      config.value = {
        ...res,
        llm: {
          ...res.llm,
          api_key: apiKey,
        },
      }
    }
    if (err) {
      error.value = err
      throw err
    }
  }

  return {
    config,
    loading,
    error,
    loadConfig,
    saveConfig,
  }
})
