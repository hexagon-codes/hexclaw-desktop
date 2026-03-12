<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Key, Shield, Globe, Info, Database, Bell, Server, Palette, Eye, EyeOff } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { useValidation, rules } from '@/composables/useValidation'
import { setLocale } from '@/i18n'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { themeMode, setTheme } = useTheme()
const activeSection = ref('llm')
const saved = ref(false)
const showApiKey = ref(false)

// ─── 表单验证 ─────────────────────────────────────────
const {
  validateField: validateLlmField,
  validateAll: validateAllLlm,
  getError: getLlmError,
  hasErrors: hasLlmErrors,
  clearErrors: clearLlmErrors,
} = useValidation({
  api_key: [rules.apiKey('API Key 不能为空')],
  base_url: [rules.url('URL 格式无效，需以 http:// 或 https:// 开头')],
  temperature: [rules.range(0, 2, '温度值应在 0 到 2 之间')],
  max_tokens: [
    rules.positiveInt('请输入正整数'),
    rules.range(256, 128000, '值应在 256 到 128000 之间'),
  ],
})

const {
  validateField: validateSecField,
  validateAll: validateAllSec,
  getError: getSecError,
  hasErrors: hasSecErrors,
  clearErrors: clearSecErrors,
} = useValidation({
  max_tokens_per_request: [
    rules.positiveInt('请输入正整数'),
    rules.range(256, 128000, '值应在 256 到 128000 之间'),
  ],
  rate_limit_rpm: [
    rules.positiveInt('请输入正整数'),
    rules.range(1, 600, '值应在 1 到 600 之间'),
  ],
})

const sections = computed(() => [
  { key: 'llm', label: t('settings.llm.title'), icon: Key },
  { key: 'security', label: t('settings.security.title'), icon: Shield },
  { key: 'general', label: t('settings.general.title'), icon: Globe },
  { key: 'appearance', label: t('settings.appearance.title'), icon: Palette },
  { key: 'notification', label: t('settings.notification.title'), icon: Bell },
  { key: 'storage', label: t('settings.storage.title'), icon: Database },
  { key: 'mcp', label: t('settings.mcp.title'), icon: Server },
  { key: 'about', label: t('settings.about.title'), icon: Info },
])

function handleLocaleChange(locale: string) {
  setLocale(locale as 'zh-CN' | 'en')
}

onMounted(() => {
  settingsStore.loadConfig()
})

const config = computed(() => settingsStore.config)

async function saveConfig() {
  if (!settingsStore.config) return

  // 根据当前激活的配置区域执行验证
  if (activeSection.value === 'llm') {
    const valid = validateAllLlm({
      api_key: settingsStore.config.llm.api_key,
      base_url: settingsStore.config.llm.base_url,
      temperature: settingsStore.config.llm.temperature,
      max_tokens: settingsStore.config.llm.max_tokens,
    })
    if (!valid) return
  }

  if (activeSection.value === 'security') {
    const valid = validateAllSec({
      max_tokens_per_request: settingsStore.config.security.max_tokens_per_request,
      rate_limit_rpm: settingsStore.config.security.rate_limit_rpm,
    })
    if (!valid) return
  }

  await settingsStore.saveConfig(settingsStore.config)
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('settings.title')" />

    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧分类导航 -->
      <div
        class="w-[200px] flex-shrink-0 border-r p-3 space-y-1"
        :style="{ borderColor: 'var(--hc-border)' }"
      >
        <button
          v-for="section in sections"
          :key="section.key"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left"
          :style="{
            background: activeSection === section.key ? 'var(--hc-bg-hover)' : 'transparent',
            color: activeSection === section.key ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
          }"
          @click="activeSection = section.key"
        >
          <component :is="section.icon" :size="16" />
          {{ section.label }}
        </button>
      </div>

      <!-- 右侧配置表单 -->
      <div class="flex-1 overflow-y-auto p-6">
        <LoadingState v-if="settingsStore.loading" />

        <template v-else-if="config">
          <!-- LLM 配置 -->
          <div v-if="activeSection === 'llm'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.llm.title') }}</h3>

            <div class="space-y-4">
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.provider') }}</label>
                <select
                  v-model="config.llm.provider"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="qwen">通义千问</option>
                  <option value="ark">豆包 (Ark)</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.model') }}</label>
                <input
                  v-model="config.llm.model"
                  type="text"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  placeholder="gpt-4o"
                />
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.apiKey') }}</label>
                <div class="relative">
                  <input
                    v-model="config.llm.api_key"
                    :type="showApiKey ? 'text' : 'password'"
                    class="w-full rounded-lg border px-3 py-2 pr-10 text-sm outline-none"
                    :style="{ background: 'var(--hc-bg-input)', borderColor: getLlmError('api_key') ? 'var(--hc-error, #ef4444)' : 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                    placeholder="sk-..."
                    @blur="validateLlmField('api_key', config.llm.api_key)"
                  />
                  <button
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-50 hover:opacity-100 transition-opacity"
                    :style="{ color: 'var(--hc-text-muted)' }"
                    @click="showApiKey = !showApiKey"
                  >
                    <Eye v-if="!showApiKey" :size="16" />
                    <EyeOff v-else :size="16" />
                  </button>
                </div>
                <p v-if="getLlmError('api_key')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getLlmError('api_key') }}
                </p>
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.baseUrl') }}</label>
                <input
                  v-model="config.llm.base_url"
                  type="text"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: getLlmError('base_url') ? 'var(--hc-error, #ef4444)' : 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  placeholder="https://api.openai.com/v1"
                  @blur="validateLlmField('base_url', config.llm.base_url)"
                />
                <p v-if="getLlmError('base_url')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getLlmError('base_url') }}
                </p>
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.temperature') }}</label>
                <div class="flex items-center gap-3">
                  <input
                    v-model.number="config.llm.temperature"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    class="flex-1 accent-blue-500"
                    @change="validateLlmField('temperature', config.llm.temperature)"
                  />
                  <span class="text-xs tabular-nums w-8 text-right" :style="{ color: 'var(--hc-text-muted)' }">{{ config.llm.temperature }}</span>
                </div>
                <p v-if="getLlmError('temperature')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getLlmError('temperature') }}
                </p>
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.llm.maxTokens') }}</label>
                <input
                  v-model.number="config.llm.max_tokens"
                  type="number"
                  min="256"
                  max="128000"
                  step="256"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: getLlmError('max_tokens') ? 'var(--hc-error, #ef4444)' : 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  @blur="validateLlmField('max_tokens', config.llm.max_tokens)"
                />
                <p v-if="getLlmError('max_tokens')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getLlmError('max_tokens') }}
                </p>
              </div>
            </div>

            <button
              class="px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: saved ? 'var(--hc-success)' : 'var(--hc-accent)' }"
              @click="saveConfig"
            >
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- 安全设置 -->
          <div v-else-if="activeSection === 'security'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.security.title') }}</h3>

            <div class="space-y-4">
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.security.gateway') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.security.gatewayDesc') }}</p>
                </div>
                <input v-model="config.security.gateway_enabled" type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.security.injection') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.security.injectionDesc') }}</p>
                </div>
                <input v-model="config.security.injection_detection" type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.security.pii') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.security.piiDesc') }}</p>
                </div>
                <input v-model="config.security.pii_filter" type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.security.contentFilter') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.security.contentFilterDesc') }}</p>
                </div>
                <input v-model="config.security.content_filter" type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.security.maxTokens') }}</label>
                <input
                  v-model.number="config.security.max_tokens_per_request"
                  type="number"
                  min="256"
                  max="128000"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: getSecError('max_tokens_per_request') ? 'var(--hc-error, #ef4444)' : 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  @blur="validateSecField('max_tokens_per_request', config.security.max_tokens_per_request)"
                />
                <p v-if="getSecError('max_tokens_per_request')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getSecError('max_tokens_per_request') }}
                </p>
              </div>

              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.security.rateLimit') }}</label>
                <input
                  v-model.number="config.security.rate_limit_rpm"
                  type="number"
                  min="1"
                  max="600"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: getSecError('rate_limit_rpm') ? 'var(--hc-error, #ef4444)' : 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  @blur="validateSecField('rate_limit_rpm', config.security.rate_limit_rpm)"
                />
                <p v-if="getSecError('rate_limit_rpm')" class="text-xs mt-1" style="color: var(--hc-error, #ef4444)">
                  {{ getSecError('rate_limit_rpm') }}
                </p>
              </div>
            </div>

            <button
              class="px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: saved ? 'var(--hc-success)' : 'var(--hc-accent)' }"
              @click="saveConfig"
            >
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- 通用设置 -->
          <div v-else-if="activeSection === 'general'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.general.title') }}</h3>

            <div class="space-y-4">
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.general.language') }}</label>
                <select
                  v-model="config.general.language"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  @change="handleLocaleChange(config.general.language)"
                >
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.general.logLevel') }}</label>
                <select
                  v-model="config.general.log_level"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.general.dataDir') }}</label>
                <input
                  v-model="config.general.data_dir"
                  type="text"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  placeholder="~/.hexclaw"
                />
              </div>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.general.autoStart') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.general.autoStartDesc') }}</p>
                </div>
                <input v-model="config.general.auto_start" type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>
            </div>

            <button
              class="px-4 py-2 rounded-lg text-sm font-medium text-white"
              :style="{ background: saved ? 'var(--hc-success)' : 'var(--hc-accent)' }"
              @click="saveConfig"
            >
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- 外观设置 -->
          <div v-else-if="activeSection === 'appearance'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.appearance.title') }}</h3>

            <div class="space-y-4">
              <div>
                <label class="block text-sm mb-3" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.appearance.themeMode') }}</label>
                <div class="flex gap-3">
                  <button
                    v-for="opt in [
                      { key: 'light' as ThemeMode, label: t('settings.appearance.light'), desc: t('settings.appearance.lightDesc') },
                      { key: 'dark' as ThemeMode, label: t('settings.appearance.dark'), desc: t('settings.appearance.darkDesc') },
                      { key: 'system' as ThemeMode, label: t('settings.appearance.system'), desc: t('settings.appearance.systemDesc') },
                    ]"
                    :key="opt.key"
                    class="flex-1 rounded-xl border p-4 text-left transition-colors"
                    :style="{
                      background: themeMode === opt.key ? 'var(--hc-bg-hover)' : 'var(--hc-bg-card)',
                      borderColor: themeMode === opt.key ? 'var(--hc-accent)' : 'var(--hc-border)',
                    }"
                    @click="setTheme(opt.key)"
                  >
                    <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ opt.label }}</div>
                    <div class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ opt.desc }}</div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 通知设置 -->
          <div v-else-if="activeSection === 'notification'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.notification.title') }}</h3>

            <div class="space-y-4">
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.notification.system') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.notification.systemDesc') }}</p>
                </div>
                <input type="checkbox" checked class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.notification.sound') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.notification.soundDesc') }}</p>
                </div>
                <input type="checkbox" class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.notification.cron') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.notification.cronDesc') }}</p>
                </div>
                <input type="checkbox" checked class="accent-blue-500 w-4 h-4" />
              </label>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.notification.heartbeat') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.notification.heartbeatDesc') }}</p>
                </div>
                <input type="checkbox" checked class="accent-blue-500 w-4 h-4" />
              </label>
            </div>

            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('settings.notification.hint') }}
            </p>
          </div>

          <!-- 存储设置 -->
          <div v-else-if="activeSection === 'storage'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.storage.title') }}</h3>

            <div class="space-y-4">
              <div
                class="rounded-xl border p-4 space-y-3"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
              >
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.storage.vectorDb') }}</div>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.type') }}</span>
                    <div class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">Qdrant</div>
                  </div>
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.status') }}</span>
                    <div class="text-sm" :style="{ color: 'var(--hc-success)' }">{{ t('settings.storage.running') }}</div>
                  </div>
                </div>
              </div>

              <div
                class="rounded-xl border p-4 space-y-3"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
              >
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.storage.sessionData') }}</div>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.type') }}</span>
                    <div class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">SQLite</div>
                  </div>
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.path') }}</span>
                    <div class="text-sm truncate" :style="{ color: 'var(--hc-text-primary)' }">~/.hexclaw/data.db</div>
                  </div>
                </div>
              </div>

              <div
                class="rounded-xl border p-4 space-y-3"
                :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
              >
                <div class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.storage.cache') }}</div>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.semanticCache') }}</span>
                    <div class="text-sm" :style="{ color: 'var(--hc-success)' }">{{ t('settings.storage.enabled') }}</div>
                  </div>
                  <div>
                    <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.storage.localCache') }}</span>
                    <div class="text-sm" :style="{ color: 'var(--hc-success)' }">{{ t('settings.storage.enabled') }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- MCP 服务 -->
          <div v-else-if="activeSection === 'mcp'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.mcp.title') }}</h3>
            <p class="text-sm" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ t('settings.mcp.desc') }}
              <button
                class="text-blue-400 hover:underline"
                @click="$router.push('/mcp')"
              >
                {{ t('settings.mcp.mcpPage') }}
              </button>
            </p>

            <div class="space-y-4">
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('settings.mcp.defaultProtocol') }}</label>
                <select
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">SSE</option>
                  <option value="streamable_http">Streamable HTTP</option>
                </select>
              </div>
              <label class="flex items-center justify-between cursor-pointer">
                <div>
                  <span class="text-sm" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.mcp.autoReconnect') }}</span>
                  <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.mcp.autoReconnectDesc') }}</p>
                </div>
                <input type="checkbox" checked class="accent-blue-500 w-4 h-4" />
              </label>
            </div>
          </div>

          <!-- 关于 -->
          <div v-else-if="activeSection === 'about'" class="max-w-lg space-y-6">
            <h3 class="text-base font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('settings.about.title') }}</h3>

            <div
              class="rounded-xl border p-5 space-y-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex items-center gap-4">
                <div
                  class="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-bold"
                  :style="{ background: 'var(--hc-accent)', color: '#fff' }"
                >
                  HC
                </div>
                <div>
                  <div class="text-lg font-semibold" :style="{ color: 'var(--hc-text-primary)' }">HexClaw Desktop</div>
                  <div class="text-sm" :style="{ color: 'var(--hc-text-muted)' }">v0.0.1</div>
                </div>
              </div>

              <div class="space-y-2 text-sm" :style="{ color: 'var(--hc-text-secondary)' }">
                <p>{{ t('settings.about.tagline') }}</p>
                <p>{{ t('settings.about.builtWith') }}</p>
              </div>

              <div class="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.about.frontend') }}</span>
                  <div :style="{ color: 'var(--hc-text-primary)' }">Vue 3 + TypeScript</div>
                </div>
                <div>
                  <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.about.desktop') }}</span>
                  <div :style="{ color: 'var(--hc-text-primary)' }">Tauri v2 (Rust)</div>
                </div>
                <div>
                  <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.about.agentFramework') }}</span>
                  <div :style="{ color: 'var(--hc-text-primary)' }">Hexagon</div>
                </div>
                <div>
                  <span :style="{ color: 'var(--hc-text-muted)' }">{{ t('settings.about.license') }}</span>
                  <div :style="{ color: 'var(--hc-text-primary)' }">MIT</div>
                </div>
              </div>

              <div class="pt-2 flex gap-3">
                <a
                  href="https://github.com/everyday-items/hexclaw-desktop"
                  target="_blank"
                  class="text-sm text-blue-400 hover:underline"
                >
                  GitHub
                </a>
                <a
                  href="https://github.com/everyday-items/hexclaw-desktop/issues"
                  target="_blank"
                  class="text-sm text-blue-400 hover:underline"
                >
                  {{ t('settings.about.feedback') }}
                </a>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
