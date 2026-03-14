<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Key, Shield, Globe, Database, Bell, Server, Palette, Eye, EyeOff, Cpu, Plus, Trash2, ChevronDown, ChevronUp, Power } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '@/stores/settings'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { useValidation, rules } from '@/composables/useValidation'
import { setLocale } from '@/i18n'
import { PROVIDER_PRESETS, getProviderTypes } from '@/config/providers'
import type { ProviderConfig, ProviderType, ModelOption, ModelCapability } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()
const router = useRouter()
const settingsStore = useSettingsStore()
const { themeMode, setTheme } = useTheme()
const activeSection = ref('llm')
const saved = ref(false)

// Provider 编辑状态
const editingProviderId = ref<string | null>(null)
const showApiKeys = ref<Record<string, boolean>>({})
const showAddProvider = ref(false)
const addProviderType = ref<ProviderType>('openai')

// 自定义模型输入
const newModelId = ref('')
const newModelName = ref('')
const newModelCaps = ref<Record<ModelCapability, boolean>>({ text: true, vision: false, video: false, audio: false, code: false })

const {
  validateField: validateSecField,
  validateAll: validateAllSec,
  getError: getSecError,
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
  { key: 'engine', label: t('settings.engine.title'), icon: Cpu },
])

// 引擎运行时版本
const engineRefreshing = ref(false)
const engineInfo = ref({
  hexclaw: { version: '-', status: 'checking' as 'checking' | 'running' | 'stopped' | 'update' },
  hexagon: { version: '-' },
  goVersion: '-',
})

async function checkEngineStatus() {
  try {
    // 通过 Tauri command 代理请求，绕过 CORS
    const text = await invoke<string>('proxy_api_request', {
      method: 'GET',
      path: '/health',
      body: null,
    })
    const data = JSON.parse(text)
    engineInfo.value.hexclaw.version = data.version || '0.0.1'
    engineInfo.value.hexclaw.status = 'running'
    engineInfo.value.hexagon.version = data.hexagon_version || '0.1.0'
    engineInfo.value.goVersion = data.go_version || 'go1.23'
  } catch {
    engineInfo.value.hexclaw.status = 'stopped'
    engineInfo.value.hexclaw.version = '0.0.1'
    engineInfo.value.hexagon.version = '0.1.0'
    engineInfo.value.goVersion = 'go1.23'
  }
}

async function refreshEngine() {
  if (engineRefreshing.value) return
  engineRefreshing.value = true
  engineInfo.value.hexclaw.status = 'checking'
  await checkEngineStatus()
  // 保持动画至少转完一圈
  setTimeout(() => { engineRefreshing.value = false }, 600)
}

function handleLocaleChange(locale: string) {
  setLocale(locale as 'zh-CN' | 'en')
}

onMounted(() => {
  settingsStore.loadConfig()
  checkEngineStatus()
})

const config = computed(() => settingsStore.config)

/** 添加一个新 Provider */
function handleAddProvider() {
  const preset = PROVIDER_PRESETS[addProviderType.value]
  settingsStore.addProvider({
    name: preset.name,
    type: preset.type,
    enabled: true,
    apiKey: '',
    baseUrl: preset.defaultBaseUrl,
    models: [...preset.defaultModels],
  })
  showAddProvider.value = false
  // 自动展开编辑
  const providers = settingsStore.config?.llm?.providers
  if (providers?.length) {
    editingProviderId.value = providers[providers.length - 1]!.id
  }
}

/** 删除 Provider */
function handleDeleteProvider(id: string) {
  if (!confirm(t('settings.llm.deleteProviderConfirm'))) return
  settingsStore.removeProvider(id)
  if (editingProviderId.value === id) {
    editingProviderId.value = null
  }
}

/** 切换 Provider 启用/禁用 */
function toggleProvider(provider: ProviderConfig) {
  settingsStore.updateProvider(provider.id, { enabled: !provider.enabled })
}

/** 添加自定义模型到 Provider */
function addCustomModel(provider: ProviderConfig) {
  if (!newModelId.value.trim()) return
  const caps = (Object.entries(newModelCaps.value) as [ModelCapability, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)
  const model: ModelOption = {
    id: newModelId.value.trim(),
    name: newModelName.value.trim() || newModelId.value.trim(),
    isCustom: true,
    capabilities: caps.length > 0 ? caps : ['text'],
  }
  settingsStore.updateProvider(provider.id, {
    models: [...provider.models, model],
  })
  newModelId.value = ''
  newModelName.value = ''
  newModelCaps.value = { text: true, vision: false, video: false, audio: false, code: false }
}

/** 删除模型 */
function removeModel(provider: ProviderConfig, modelId: string) {
  settingsStore.updateProvider(provider.id, {
    models: provider.models.filter((m) => m.id !== modelId),
  })
}

async function saveConfig() {
  if (!settingsStore.config) return

  // 如果有未提交的自定义模型输入，自动添加到当前编辑的 Provider
  if (newModelId.value.trim() && editingProviderId.value) {
    const provider = settingsStore.config.llm.providers.find((p) => p.id === editingProviderId.value)
    if (provider) {
      addCustomModel(provider)
    }
  }

  const secValues = {
    max_tokens_per_request: settingsStore.config.security.max_tokens_per_request,
    rate_limit_rpm: settingsStore.config.security.rate_limit_rpm,
  }
  const secValid = validateAllSec(secValues)
  if (!secValid) return

  try {
    await settingsStore.saveConfig(settingsStore.config)
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } catch (e) {
    console.error('保存配置失败:', e)
  }
}
</script>

<template>
  <div class="hc-settings">
    <PageHeader :title="t('settings.title')" />

    <div class="hc-settings__body">
      <!-- Left nav -->
      <div class="hc-settings__nav">
        <button
          v-for="section in sections"
          :key="section.key"
          class="hc-settings__nav-item"
          :class="{ 'hc-settings__nav-item--active': activeSection === section.key }"
          @click="activeSection = section.key"
        >
          <component :is="section.icon" :size="16" class="hc-settings__nav-icon" />
          {{ section.label }}
        </button>
      </div>

      <!-- Right content -->
      <div class="hc-settings__content">
        <LoadingState v-if="settingsStore.loading" />

        <template v-else-if="config">
          <!-- LLM Providers -->
          <div v-if="activeSection === 'llm'" class="hc-settings__section" style="max-width: 600px;">
            <div class="hc-provider__header">
              <h3 class="hc-settings__section-title" style="margin: 0;">{{ t('settings.llm.title') }}</h3>
              <button class="hc-btn hc-btn-sm" @click="showAddProvider = !showAddProvider">
                <Plus :size="14" />
                {{ t('settings.llm.addProvider') }}
              </button>
            </div>

            <!-- 添加 Provider 面板 -->
            <div v-if="showAddProvider" class="hc-provider__add-panel">
              <label class="hc-settings__label">{{ t('settings.llm.selectProvider') }}</label>
              <div class="hc-provider__type-grid">
                <button
                  v-for="preset in getProviderTypes()"
                  :key="preset.type"
                  class="hc-provider__type-btn"
                  :class="{ 'hc-provider__type-btn--active': addProviderType === preset.type }"
                  @click="addProviderType = preset.type"
                >
                  {{ preset.name }}
                </button>
              </div>
              <div class="hc-provider__add-actions">
                <button class="hc-btn hc-btn-sm" @click="showAddProvider = false">{{ t('common.cancel') }}</button>
                <button class="hc-btn hc-btn-primary hc-btn-sm" @click="handleAddProvider">{{ t('common.confirm') }}</button>
              </div>
            </div>

            <!-- Provider 列表 -->
            <div v-if="config.llm.providers.length === 0 && !showAddProvider" class="hc-provider__empty">
              <p class="hc-provider__empty-title">{{ t('settings.llm.noProviders') }}</p>
              <p class="hc-provider__empty-desc">{{ t('settings.llm.noProvidersDesc') }}</p>
            </div>

            <div class="hc-provider__list">
              <div
                v-for="provider in config.llm.providers"
                :key="provider.id"
                class="hc-provider__card"
                :class="{ 'hc-provider__card--disabled': !provider.enabled }"
              >
                <!-- Provider 头部 -->
                <div class="hc-provider__card-head" @click="editingProviderId = editingProviderId === provider.id ? null : provider.id">
                  <div class="hc-provider__card-info">
                    <span class="hc-provider__led" :class="provider.enabled ? 'hc-provider__led--on' : 'hc-provider__led--off'" />
                    <span class="hc-provider__card-name">{{ provider.name }}</span>
                    <span class="hc-provider__tag">{{ provider.type }}</span>
                    <span class="hc-provider__model-count">{{ provider.models.length }} {{ t('settings.llm.models').toLowerCase() }}</span>
                  </div>
                  <div class="hc-provider__card-actions">
                    <button class="hc-provider__icon-btn" :title="provider.enabled ? t('settings.llm.enabled') : t('settings.llm.disabled')" @click.stop="toggleProvider(provider)">
                      <Power :size="14" :class="provider.enabled ? 'hc-provider__power--on' : 'hc-provider__power--off'" />
                    </button>
                    <component :is="editingProviderId === provider.id ? ChevronUp : ChevronDown" :size="14" class="hc-provider__chevron" />
                  </div>
                </div>

                <!-- Provider 编辑面板 -->
                <div v-if="editingProviderId === provider.id" class="hc-provider__edit">
                  <div class="hc-settings__field">
                    <label class="hc-settings__label">{{ t('settings.llm.provider') }} <span class="hc-settings__required">*</span></label>
                    <input v-model="provider.name" type="text" class="hc-input" />
                  </div>

                  <div class="hc-settings__field">
                    <label class="hc-settings__label">{{ t('settings.llm.apiKey') }} <span class="hc-settings__required">*</span></label>
                    <div class="hc-settings__input-group">
                      <input
                        v-model="provider.apiKey"
                        :type="showApiKeys[provider.id] ? 'text' : 'password'"
                        class="hc-input"
                        :placeholder="PROVIDER_PRESETS[provider.type]?.placeholder || 'API Key'"
                      />
                      <button class="hc-settings__eye-btn" @click="showApiKeys[provider.id] = !showApiKeys[provider.id]">
                        <Eye v-if="!showApiKeys[provider.id]" :size="15" />
                        <EyeOff v-else :size="15" />
                      </button>
                    </div>
                  </div>

                  <div class="hc-settings__field">
                    <label class="hc-settings__label">{{ t('settings.llm.baseUrl') }} <span class="hc-settings__required">*</span></label>
                    <input v-model="provider.baseUrl" type="text" class="hc-input" :placeholder="PROVIDER_PRESETS[provider.type]?.defaultBaseUrl" />
                  </div>

                  <!-- 模型列表 -->
                  <div class="hc-settings__field">
                    <label class="hc-settings__label">{{ t('settings.llm.models') }} <span class="hc-settings__required">*</span></label>
                    <div class="hc-provider__models">
                      <div v-for="model in provider.models" :key="model.id" class="hc-provider__model-item">
                        <span class="hc-provider__model-name">{{ model.name }}</span>
                        <span class="hc-provider__model-id">{{ model.id }}</span>
                        <span class="hc-provider__model-caps">
                          <span v-if="(model.capabilities || ['text']).includes('vision')" class="hc-cap-tag hc-cap-tag--vision">视觉</span>
                          <span v-if="(model.capabilities || []).includes('video')" class="hc-cap-tag hc-cap-tag--video">视频</span>
                          <span v-if="(model.capabilities || []).includes('audio')" class="hc-cap-tag hc-cap-tag--audio">音频</span>
                        </span>
                        <button v-if="model.isCustom" class="hc-provider__model-del" @click="removeModel(provider, model.id)">×</button>
                      </div>
                    </div>

                    <!-- 添加自定义模型 -->
                    <div class="hc-provider__add-model">
                      <input v-model="newModelId" type="text" class="hc-input hc-input--sm" :placeholder="t('settings.llm.modelIdHint')" />
                      <input v-model="newModelName" type="text" class="hc-input hc-input--sm" :placeholder="t('settings.llm.modelNameHint')" />
                      <button class="hc-btn hc-btn-sm" @click="addCustomModel(provider)">
                        <Plus :size="12" />
                      </button>
                    </div>
                    <!-- 模型能力复选框 -->
                    <div class="hc-provider__caps-row">
                      <span class="hc-provider__caps-label">能力:</span>
                      <label v-for="cap in (['text', 'vision', 'video', 'audio'] as ModelCapability[])" :key="cap" class="hc-provider__cap-check">
                        <input v-model="newModelCaps[cap]" type="checkbox" :disabled="cap === 'text'" />
                        <span>{{ cap === 'text' ? '文本' : cap === 'vision' ? '视觉' : cap === 'video' ? '视频' : '音频' }}</span>
                      </label>
                    </div>
                  </div>

                  <div class="hc-provider__edit-footer">
                    <button class="hc-provider__delete-btn" @click="handleDeleteProvider(provider.id)">
                      <Trash2 :size="13" />
                      {{ t('settings.llm.deleteProvider') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <button class="hc-btn hc-btn-primary" :class="{ 'hc-settings__btn--saved': saved }" style="margin-top: 20px;" @click="saveConfig">
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- Security -->
          <div v-else-if="activeSection === 'security'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.security.title') }}</h3>

            <div class="hc-settings__form">
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.security.gateway') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.security.gatewayDesc') }}</p>
                </div>
                <input v-model="config.security.gateway_enabled" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.security.injection') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.security.injectionDesc') }}</p>
                </div>
                <input v-model="config.security.injection_detection" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.security.pii') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.security.piiDesc') }}</p>
                </div>
                <input v-model="config.security.pii_filter" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.security.contentFilter') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.security.contentFilterDesc') }}</p>
                </div>
                <input v-model="config.security.content_filter" type="checkbox" class="hc-toggle" />
              </label>

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.security.maxTokens') }}</label>
                <input
                  v-model.number="config.security.max_tokens_per_request"
                  type="number" min="256" max="128000"
                  class="hc-input"
                  :class="{ 'hc-settings__input--error': getSecError('max_tokens_per_request') }"
                  @blur="validateSecField('max_tokens_per_request', config.security.max_tokens_per_request)"
                />
                <p v-if="getSecError('max_tokens_per_request')" class="hc-settings__error">{{ getSecError('max_tokens_per_request') }}</p>
              </div>

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.security.rateLimit') }}</label>
                <input
                  v-model.number="config.security.rate_limit_rpm"
                  type="number" min="1" max="600"
                  class="hc-input"
                  :class="{ 'hc-settings__input--error': getSecError('rate_limit_rpm') }"
                  @blur="validateSecField('rate_limit_rpm', config.security.rate_limit_rpm)"
                />
                <p v-if="getSecError('rate_limit_rpm')" class="hc-settings__error">{{ getSecError('rate_limit_rpm') }}</p>
              </div>
            </div>

            <button class="hc-btn hc-btn-primary" :class="{ 'hc-settings__btn--saved': saved }" @click="saveConfig">
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- General -->
          <div v-else-if="activeSection === 'general'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.general.title') }}</h3>

            <div class="hc-settings__form">
              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.general.language') }}</label>
                <select v-model="config.general.language" class="hc-input" @change="handleLocaleChange(config.general.language)">
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.general.logLevel') }}</label>
                <select v-model="config.general.log_level" class="hc-input">
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
              </div>

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.general.dataDir') }}</label>
                <input v-model="config.general.data_dir" type="text" class="hc-input" placeholder="~/.hexclaw" />
              </div>

              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.general.autoStart') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.general.autoStartDesc') }}</p>
                </div>
                <input v-model="config.general.auto_start" type="checkbox" class="hc-toggle" />
              </label>
            </div>

            <button class="hc-btn hc-btn-primary" :class="{ 'hc-settings__btn--saved': saved }" @click="saveConfig">
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- Appearance -->
          <div v-else-if="activeSection === 'appearance'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.appearance.title') }}</h3>

            <div class="hc-settings__form">
              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.appearance.themeMode') }}</label>
                <div class="hc-settings__theme-grid">
                  <button
                    v-for="opt in [
                      { key: 'light' as ThemeMode, label: t('settings.appearance.light'), desc: t('settings.appearance.lightDesc') },
                      { key: 'dark' as ThemeMode, label: t('settings.appearance.dark'), desc: t('settings.appearance.darkDesc') },
                      { key: 'system' as ThemeMode, label: t('settings.appearance.system'), desc: t('settings.appearance.systemDesc') },
                    ]"
                    :key="opt.key"
                    class="hc-settings__theme-card"
                    :class="{ 'hc-settings__theme-card--active': themeMode === opt.key }"
                    @click="setTheme(opt.key)"
                  >
                    <div class="hc-settings__theme-label">{{ opt.label }}</div>
                    <div class="hc-settings__theme-desc">{{ opt.desc }}</div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Notification -->
          <div v-else-if="activeSection === 'notification'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.notification.title') }}</h3>

            <div class="hc-settings__form">
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.notification.system') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.notification.systemDesc') }}</p>
                </div>
                <input v-model="config.notification.system_enabled" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.notification.sound') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.notification.soundDesc') }}</p>
                </div>
                <input v-model="config.notification.sound_enabled" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.notification.cron') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.notification.cronDesc') }}</p>
                </div>
                <input v-model="config.notification.agent_complete" type="checkbox" class="hc-toggle" />
              </label>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.notification.heartbeat') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.notification.heartbeatDesc') }}</p>
                </div>
                <input v-model="config.notification.agent_complete" type="checkbox" class="hc-toggle" />
              </label>
            </div>

            <p class="hc-settings__hint">{{ t('settings.notification.hint') }}</p>
          </div>

          <!-- Storage -->
          <div v-else-if="activeSection === 'storage'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.storage.title') }}</h3>

            <div class="hc-settings__form">
              <div class="hc-card" style="padding: 16px;">
                <div class="hc-settings__info-title">{{ t('settings.storage.vectorDb') }}</div>
                <div class="hc-settings__info-grid">
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.type') }}</span>
                    <div class="hc-settings__info-value">Qdrant</div>
                  </div>
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.status') }}</span>
                    <div class="hc-settings__info-value" style="color: var(--hc-success);">{{ t('settings.storage.running') }}</div>
                  </div>
                </div>
              </div>

              <div class="hc-card" style="padding: 16px;">
                <div class="hc-settings__info-title">{{ t('settings.storage.sessionData') }}</div>
                <div class="hc-settings__info-grid">
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.type') }}</span>
                    <div class="hc-settings__info-value">SQLite</div>
                  </div>
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.path') }}</span>
                    <div class="hc-settings__info-value" style="overflow: hidden; text-overflow: ellipsis;">~/.hexclaw/data.db</div>
                  </div>
                </div>
              </div>

              <div class="hc-card" style="padding: 16px;">
                <div class="hc-settings__info-title">{{ t('settings.storage.cache') }}</div>
                <div class="hc-settings__info-grid">
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.semanticCache') }}</span>
                    <div class="hc-settings__info-value" style="color: var(--hc-success);">{{ t('settings.storage.enabled') }}</div>
                  </div>
                  <div>
                    <span class="hc-settings__info-label">{{ t('settings.storage.localCache') }}</span>
                    <div class="hc-settings__info-value" style="color: var(--hc-success);">{{ t('settings.storage.enabled') }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- MCP -->
          <div v-else-if="activeSection === 'mcp'" class="hc-settings__section">
            <h3 class="hc-settings__section-title">{{ t('settings.mcp.title') }}</h3>
            <p class="hc-settings__desc-text">
              {{ t('settings.mcp.desc') }}
              <button class="hc-settings__link" @click="router.push('/mcp')">{{ t('settings.mcp.mcpPage') }}</button>
            </p>

            <div class="hc-settings__form">
              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.mcp.defaultProtocol') }}</label>
                <select v-model="config.mcp.default_protocol" class="hc-input">
                  <option value="stdio">stdio</option>
                  <option value="sse">SSE</option>
                  <option value="streamable_http">Streamable HTTP</option>
                </select>
              </div>
              <label class="hc-settings__toggle-row">
                <div>
                  <span class="hc-settings__toggle-label">{{ t('settings.mcp.autoReconnect') }}</span>
                  <p class="hc-settings__toggle-desc">{{ t('settings.mcp.autoReconnectDesc') }}</p>
                </div>
                <input type="checkbox" checked class="hc-toggle" />
              </label>
            </div>
          </div>

          <!-- Engine -->
          <div v-else-if="activeSection === 'engine'" class="hc-settings__section">
            <div class="hc-engine__header">
              <div>
                <h3 class="hc-settings__section-title">{{ t('settings.engine.title') }}</h3>
                <p class="hc-settings__desc-text">{{ t('settings.engine.desc') }}</p>
              </div>
              <button
                class="hc-engine__refresh-btn"
                :class="{ 'hc-engine__refresh-btn--spinning': engineRefreshing }"
                @click="refreshEngine"
                :title="t('settings.engine.refresh')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              </button>
            </div>

            <div class="hc-engine__cards">
              <!-- HexClaw Engine -->
              <div class="hc-engine__card">
                <div class="hc-engine__card-head">
                  <span class="hc-engine__led" :class="'hc-engine__led--' + engineInfo.hexclaw.status" />
                  <span class="hc-engine__card-title">HexClaw Engine</span>
                  <span class="hc-engine__tag hc-engine__tag--go">Go</span>
                </div>
                <table class="hc-engine__table">
                  <tr>
                    <td>{{ t('settings.engine.version') }}</td>
                    <td>{{ engineInfo.hexclaw.version }}</td>
                  </tr>
                  <tr>
                    <td>{{ t('settings.engine.endpoint') }}</td>
                    <td>localhost:16060</td>
                  </tr>
                  <tr>
                    <td>Go Runtime</td>
                    <td>{{ engineInfo.goVersion }}</td>
                  </tr>
                </table>
              </div>

              <!-- Hexagon Engine -->
              <div class="hc-engine__card">
                <div class="hc-engine__card-head">
                  <span class="hc-engine__led hc-engine__led--running" />
                  <span class="hc-engine__card-title">Hexagon Agent Engine</span>
                  <span class="hc-engine__tag hc-engine__tag--core">Core</span>
                </div>
                <table class="hc-engine__table">
                  <tr>
                    <td>{{ t('settings.engine.version') }}</td>
                    <td>{{ engineInfo.hexagon.version }}</td>
                  </tr>
                  <tr>
                    <td>{{ t('settings.engine.capabilities') }}</td>
                    <td>ReAct · Plan &amp; Execute · Tool Call</td>
                  </tr>
                </table>
              </div>

              <!-- ai-core -->
              <div class="hc-engine__card">
                <div class="hc-engine__card-head">
                  <span class="hc-engine__led hc-engine__led--running" />
                  <span class="hc-engine__card-title">ai-core</span>
                  <span class="hc-engine__tag hc-engine__tag--llm">LLM</span>
                </div>
                <table class="hc-engine__table">
                  <tr>
                    <td>{{ t('settings.engine.providers') }}</td>
                    <td>OpenAI · Claude · DeepSeek</td>
                  </tr>
                </table>
              </div>
            </div>
          </div>

        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-settings {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-settings__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ─── Nav ───── */
.hc-settings__nav {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--hc-border-subtle);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.hc-settings__nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--hc-radius-sm);
  font-size: 13px;
  color: var(--hc-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.hc-settings__nav-item:hover {
  background: var(--hc-bg-hover);
}

.hc-settings__nav-item--active {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  font-weight: 500;
}

.hc-settings__nav-icon {
  opacity: 0.7;
}

.hc-settings__nav-item--active .hc-settings__nav-icon {
  opacity: 1;
  color: var(--hc-accent);
}

/* ─── Content ───── */
.hc-settings__content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.hc-settings__section {
  max-width: 520px;
  animation: hc-fade-in 0.25s ease-out;
}

.hc-settings__section-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--hc-text-primary);
  margin: 0 0 20px;
  letter-spacing: -0.01em;
}

.hc-settings__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}

.hc-settings__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-settings__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-settings__input-group {
  position: relative;
}

.hc-settings__input-group .hc-input {
  padding-right: 36px;
}

.hc-settings__eye-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  transition: color 0.15s;
}

.hc-settings__eye-btn:hover {
  color: var(--hc-text-secondary);
}

.hc-settings__required {
  color: var(--hc-error);
  font-weight: 400;
  margin-left: 1px;
}

.hc-settings__optional {
  color: var(--hc-text-muted);
  font-weight: 400;
  font-size: 11px;
  margin-left: 4px;
}

.hc-settings__input--error {
  border-color: var(--hc-error) !important;
}

.hc-settings__error {
  font-size: 12px;
  color: var(--hc-error);
  margin: 0;
}

.hc-settings__slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hc-settings__range {
  flex: 1;
  accent-color: var(--hc-accent);
  height: 4px;
}

.hc-settings__range-value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  width: 28px;
  text-align: right;
}

/* ─── Toggle Row ───── */
.hc-settings__toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  cursor: pointer;
}

.hc-settings__toggle-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-settings__toggle-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 2px 0 0;
}

/* ─── Theme Cards ───── */
.hc-settings__theme-grid {
  display: flex;
  gap: 10px;
}

.hc-settings__theme-card {
  flex: 1;
  border-radius: var(--hc-radius-md);
  border: 1.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.hc-settings__theme-card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-settings__theme-card--active {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-settings__theme-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-settings__theme-desc {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}

/* ─── Info Display ───── */
.hc-settings__info-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin-bottom: 12px;
}

.hc-settings__info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.hc-settings__info-label {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-settings__info-value {
  font-size: 13px;
  color: var(--hc-text-primary);
  margin-top: 2px;
}


/* ─── Engine ───── */
.hc-engine__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.hc-engine__refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.hc-engine__refresh-btn:hover {
  color: var(--hc-accent);
  border-color: var(--hc-accent);
}

.hc-engine__refresh-btn--spinning svg {
  animation: hc-spin 0.6s linear infinite;
}

@keyframes hc-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.hc-engine__cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-engine__card {
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
}

.hc-engine__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-engine__led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-engine__led--running {
  background: #34c759;
  box-shadow: 0 0 6px rgba(52, 199, 89, 0.4);
}

.hc-engine__led--stopped {
  background: #ff453a;
  box-shadow: 0 0 6px rgba(255, 69, 58, 0.4);
}

.hc-engine__led--checking {
  background: var(--hc-text-muted);
  opacity: 0.5;
}

.hc-engine__card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-engine__tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
  margin-left: auto;
}

.hc-engine__tag--go {
  color: #00add8;
  background: rgba(0, 173, 216, 0.1);
}

.hc-engine__tag--core {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-engine__tag--llm {
  color: #af52de;
  background: rgba(175, 82, 222, 0.1);
}

.hc-engine__table {
  width: 100%;
  border-collapse: collapse;
}

.hc-engine__table td {
  font-size: 12px;
  padding: 3px 0;
}

.hc-engine__table td:first-child {
  color: var(--hc-text-muted);
  width: 100px;
}

.hc-engine__table td:last-child {
  color: var(--hc-text-secondary);
  font-family: 'SF Mono', 'Menlo', monospace;
  text-align: right;
}

/* ─── Provider Management ───── */
.hc-provider__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.hc-provider__add-panel {
  padding: 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hc-provider__type-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-provider__type-btn {
  padding: 5px 12px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-provider__type-btn:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-provider__type-btn--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-provider__add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.hc-provider__empty {
  padding: 32px 16px;
  text-align: center;
}

.hc-provider__empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  margin: 0 0 4px;
}

.hc-provider__empty-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 0;
}

.hc-provider__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-provider__card {
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  overflow: hidden;
  transition: border-color 0.15s;
}

.hc-provider__card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-provider__card--disabled {
  opacity: 0.6;
}

.hc-provider__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}

.hc-provider__card-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-provider__led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-provider__led--on {
  background: #34c759;
  box-shadow: 0 0 5px rgba(52, 199, 89, 0.35);
}

.hc-provider__led--off {
  background: var(--hc-text-muted);
  opacity: 0.4;
}

.hc-provider__card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-provider__tag {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.hc-provider__model-count {
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-provider__card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-provider__icon-btn {
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  display: flex;
  transition: background 0.15s;
}

.hc-provider__icon-btn:hover {
  background: var(--hc-bg-hover);
}

.hc-provider__power--on {
  color: #34c759;
}

.hc-provider__power--off {
  color: var(--hc-text-muted);
}

.hc-provider__chevron {
  color: var(--hc-text-muted);
}

.hc-provider__edit {
  padding: 0 14px 14px;
  border-top: 1px solid var(--hc-divider);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
}

.hc-provider__models {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-provider__model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-hover);
  font-size: 12px;
}

.hc-provider__model-name {
  font-weight: 500;
  color: var(--hc-text-primary);
}

.hc-provider__model-id {
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  flex: 1;
}

.hc-provider__model-del {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 14px;
  border-radius: 3px;
}

.hc-provider__model-del:hover {
  color: var(--hc-error);
  background: rgba(255, 69, 58, 0.1);
}

.hc-provider__add-model {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.hc-provider__add-model .hc-input--sm {
  font-size: 12px;
  padding: 4px 8px;
  flex: 1;
}

.hc-provider__caps-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-provider__caps-label {
  font-weight: 500;
}

.hc-provider__cap-check {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}

.hc-provider__cap-check input {
  accent-color: var(--hc-accent);
  width: 13px;
  height: 13px;
}

.hc-provider__model-caps {
  display: flex;
  gap: 3px;
  margin-left: auto;
}

.hc-cap-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}

.hc-cap-tag--vision {
  background: rgba(52, 199, 89, 0.12);
  color: #34c759;
}

.hc-cap-tag--video {
  background: rgba(255, 149, 0, 0.12);
  color: #ff9500;
}

.hc-cap-tag--audio {
  background: rgba(175, 82, 222, 0.12);
  color: #af52de;
}

.hc-provider__edit-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.hc-provider__delete-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--hc-error);
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--hc-radius-sm);
  transition: background 0.15s;
}

.hc-provider__delete-btn:hover {
  background: rgba(255, 69, 58, 0.1);
}

.hc-btn-sm {
  font-size: 12px;
  padding: 5px 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ─── Misc ───── */
.hc-settings__link {
  color: var(--hc-accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.hc-settings__link:hover {
  text-decoration: underline;
}

.hc-settings__desc-text {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin-bottom: 20px;
}

.hc-settings__hint {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-settings__btn--saved {
  background: var(--hc-success) !important;
}
</style>
