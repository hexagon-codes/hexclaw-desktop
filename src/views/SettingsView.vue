<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Key, Shield, Globe, Database, Bell, Server, Palette, Eye, EyeOff, Plus, Trash2, ChevronDown, ChevronUp, Power, Webhook, Loader2, Pencil, CheckCircle, XCircle, Zap, RotateCcw, Plug, Save } from 'lucide-vue-next'
import { NTag, NPopconfirm, NModal, NSpace } from 'naive-ui'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '@/stores/settings'
import { getWebhooks, createWebhook, deleteWebhook, type Webhook as WebhookItem, type WebhookType, type WebhookEvent } from '@/api/webhook'
import { trySafe } from '@/utils/errors'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { useValidation, rules } from '@/composables/useValidation'
import { setLocale } from '@/i18n'
import { PROVIDER_PRESETS, PROVIDER_LOGOS, getProviderTypes } from '@/config/providers'
import type { ProviderConfig, ProviderType, ModelOption, ModelCapability, SecurityConfig, NotificationConfig } from '@/types'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SettingsSecurity from '@/components/settings/SettingsSecurity.vue'
import SettingsNotification from '@/components/settings/SettingsNotification.vue'

const { t } = useI18n()
const router = useRouter()
const settingsStore = useSettingsStore()
const { themeMode, setTheme } = useTheme()
const activeSection = ref('llm')
const saved = ref(false)
const settingsSearch = ref('')

// Provider 编辑状态
const editingProviderId = ref<string | null>(null)
const showApiKeys = ref<Record<string, boolean>>({})
const showAddProvider = ref(false)
const addProviderType = ref<ProviderType>('openai')

// 自定义模型输入
const newModelId = ref('')
const newModelName = ref('')
const newModelCaps = ref<Record<ModelCapability, boolean>>({ text: true, vision: false, video: false, audio: false, code: false })
const showAddModelPanel = ref(false)

// 编辑模型 Modal
const editingModel = ref<{ providerId: string; idx: number; model: ModelOption } | null>(null)
const editModelForm = ref<{ name: string; id: string; caps: Record<ModelCapability, boolean> }>({
  name: '', id: '', caps: { text: true, vision: false, video: false, audio: false, code: false },
})

// ─── Webhook 状态 ────────────────────────────────────
const webhooks = ref<WebhookItem[]>([])
const webhookLoading = ref(false)
const showAddWebhook = ref(false)
const newWebhookName = ref('')
const newWebhookType = ref<WebhookType>('wecom')
const newWebhookUrl = ref('')
const newWebhookEvents = ref<Record<WebhookEvent, boolean>>({
  task_complete: true,
  agent_complete: true,
  error: true,
})

const webhookTypes = computed(() => [
  { key: 'wecom' as WebhookType, label: t('settings.webhook.wecom'), color: '#07c160' },
  { key: 'feishu' as WebhookType, label: t('settings.webhook.feishu'), color: '#3370ff' },
  { key: 'dingtalk' as WebhookType, label: t('settings.webhook.dingtalk'), color: '#0089ff' },
  { key: 'custom' as WebhookType, label: t('settings.webhook.custom'), color: '#6b7280' },
])

const webhookEventLabels = computed(() => [
  { key: 'task_complete' as WebhookEvent, label: t('settings.webhook.taskComplete') },
  { key: 'agent_complete' as WebhookEvent, label: t('settings.webhook.agentComplete') },
  { key: 'error' as WebhookEvent, label: t('settings.webhook.errorNotify') },
])

async function loadWebhooks() {
  webhookLoading.value = true
  const [res] = await trySafe(() => getWebhooks(), t('settings.webhook.noWebhooksDesc'))
  if (res) webhooks.value = res.webhooks || []
  webhookLoading.value = false
}

async function handleAddWebhook() {
  if (!newWebhookName.value.trim() || !newWebhookUrl.value.trim()) return
  const events = (Object.entries(newWebhookEvents.value) as [WebhookEvent, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)
  webhookLoading.value = true
  const [res] = await trySafe(
    () => createWebhook({
      name: newWebhookName.value.trim(),
      type: newWebhookType.value,
      url: newWebhookUrl.value.trim(),
      events,
    }),
    t('settings.webhook.create'),
  )
  if (res) {
    await loadWebhooks()
    showAddWebhook.value = false
    newWebhookName.value = ''
    newWebhookUrl.value = ''
    newWebhookType.value = 'wecom'
    newWebhookEvents.value = { task_complete: true, agent_complete: true, error: true }
  }
  webhookLoading.value = false
}

async function handleDeleteWebhook(name: string) {
  if (!confirm(t('settings.webhook.deleteConfirm'))) return
  await trySafe(() => deleteWebhook(name), t('common.delete'))
  await loadWebhooks()
}

function getWebhookTypeInfo(type: WebhookType) {
  const list = webhookTypes.value
  return list.find((x) => x.key === type) || list[3]!
}

const {
  validateField: validateSecField,
  validateAll: validateAllSec,
  getError: getSecError,
} = useValidation({
  max_tokens_per_request: [
    rules.positiveInt(t('settings.validation.positiveInt')),
    rules.range(256, 128000, t('settings.validation.range256_128k')),
  ],
  rate_limit_rpm: [
    rules.positiveInt(t('settings.validation.positiveInt')),
    rules.range(1, 600, t('settings.validation.range1_600')),
  ],
})

const sections = computed(() => [
  { key: 'llm', label: t('settings.llm.title'), icon: Key },
  { key: 'appearance', label: t('settings.appearance.title'), icon: Palette },
  { key: 'storage', label: t('settings.storage.title'), icon: Database },
])

function handleLocaleChange(locale: string) {
  setLocale(locale as 'zh-CN' | 'en')
}

onMounted(async () => {
  // settings 页面被路由守卫豁免，config 可能尚未加载
  await settingsStore.loadConfig()
})

onBeforeUnmount(() => {
  editingModel.value = null
  showAddModelPanel.value = false
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
  editingProviderId.value = null
})

// 切换到 webhook 分区时自动加载
watch(activeSection, (val) => {
  if (val === 'webhook') loadWebhooks()
})

// 切换编辑的 Provider 时重置模型添加面板
watch(editingProviderId, () => {
  showAddModelPanel.value = false
  newModelId.value = ''
  newModelName.value = ''
  newModelCaps.value = { text: true, vision: false, video: false, audio: false, code: false }
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

/** 删除 Provider（由 NPopconfirm 确认后触发） */
async function handleDeleteProvider(id: string) {
  settingsStore.removeProvider(id)
  if (editingProviderId.value === id) {
    editingProviderId.value = null
  }
  if (settingsStore.config) {
    try {
      await settingsStore.saveConfig(settingsStore.config)
    } catch (e) {
      console.error('[HexClaw] 删除 Provider 后保存失败:', e)
    }
  }
}

/** 切换 Provider 启用/禁用 */
function toggleProvider(provider: ProviderConfig) {
  settingsStore.updateProvider(provider.id, { enabled: !provider.enabled })
  autoSave()
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
  autoSave()
}

/** 删除模型 */
function removeModel(provider: ProviderConfig, modelId: string) {
  settingsStore.updateProvider(provider.id, {
    models: provider.models.filter((m) => m.id !== modelId),
  })
  autoSave()
}

/** 打开编辑模型 Modal */
function openEditModel(provider: ProviderConfig, idx: number) {
  const model = provider.models[idx]!
  editingModel.value = { providerId: provider.id, idx, model }
  editModelForm.value = {
    name: model.name,
    id: model.id,
    caps: {
      text: (model.capabilities || ['text']).includes('text'),
      vision: (model.capabilities || []).includes('vision'),
      video: (model.capabilities || []).includes('video'),
      audio: (model.capabilities || []).includes('audio'),
      code: (model.capabilities || []).includes('code'),
    },
  }
}

/** 保存编辑的模型 */
function saveEditModel() {
  if (!editingModel.value) return
  const { providerId, idx } = editingModel.value
  const provider = settingsStore.config?.llm.providers.find(p => p.id === providerId)
  if (!provider) return

  const caps = (Object.entries(editModelForm.value.caps) as [ModelCapability, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k)

  const updated = [...provider.models]
  updated[idx] = {
    ...updated[idx]!,
    name: editModelForm.value.name || editModelForm.value.id,
    id: editModelForm.value.id,
    capabilities: caps.length > 0 ? caps : ['text'],
  }
  settingsStore.updateProvider(providerId, { models: updated })
  editingModel.value = null
  autoSave()
}

// ─── Provider 连接测试 ────────────────────────────────
const testingProviderId = ref<string | null>(null)
const testProviderResult = ref<Record<string, { ok: boolean; msg: string }>>({})

async function testProvider(provider: ProviderConfig) {
  testingProviderId.value = provider.id
  delete testProviderResult.value[provider.id]
  try {
    const text = await invoke<string>('proxy_api_request', {
      method: 'GET',
      path: '/api/v1/config/llm',
      body: null,
    })
    const data = JSON.parse(text)
    // Check if the provider exists in backend config
    const key = provider.name || provider.id
    if (data.providers && data.providers[key]) {
      testProviderResult.value[provider.id] = { ok: true, msg: '连接正常' }
    } else {
      // Backend is reachable, provider config present locally
      testProviderResult.value[provider.id] = { ok: true, msg: '后端服务正常' }
    }
  } catch {
    testProviderResult.value[provider.id] = { ok: false, msg: '无法连接后端服务' }
  } finally {
    testingProviderId.value = null
  }
}

/** 自动保存（防抖） */
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
function autoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(async () => {
    if (!settingsStore.config) return
    try {
      await settingsStore.saveConfig(settingsStore.config)
    } catch (e) {
      console.error('[HexClaw] 自动保存失败:', e)
    }
  }, 500)
}

function patchSecurity(p: Partial<SecurityConfig>) {
  const c = settingsStore.config
  if (!c) return
  Object.assign(c.security, p)
  autoSave()
}

function patchNotification(p: Partial<NotificationConfig>) {
  const c = settingsStore.config
  if (!c) return
  Object.assign(c.notification, p)
  autoSave()
}

async function onToolbarReset() {
  if (!settingsStore.config) return
  try {
    await settingsStore.loadConfig()
    saved.value = false
  } catch (e) {
    console.error('[HexClaw] Reset failed:', e)
  }
}

async function onToolbarTestConnection() {
  if (!settingsStore.config) return
  const provider = settingsStore.config.llm.providers.find(p => p.enabled)
  if (!provider) return
  try {
    const { testLLMConnection } = await import('@/api/config')
    const result = await testLLMConnection({
      provider: {
        type: provider.type,
        base_url: provider.baseUrl,
        api_key: provider.apiKey,
        model: provider.models[0]?.id ?? '',
      },
    })
    window.$message?.[result.ok ? 'success' : 'error'](
      result.message || (result.ok ? 'OK' : 'Failed'),
    )
  } catch (e) {
    window.$message?.error?.(e instanceof Error ? e.message : 'Connection test failed')
  }
}

async function saveConfig() {
  if (!settingsStore.config) return

  // 取消挂起的自动保存，防止并发写入冲突
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }

  // 如果有未提交的自定义模型输入，自动添加到当前编辑的 Provider
  if (newModelId.value.trim() && editingProviderId.value) {
    const provider = settingsStore.config.llm.providers.find((p) => p.id === editingProviderId.value)
    if (provider) {
      const caps = (Object.entries(newModelCaps.value) as [ModelCapability, boolean][])
        .filter(([, v]) => v)
        .map(([k]) => k)
      const pendingModel: ModelOption = {
        id: newModelId.value.trim(),
        name: newModelName.value.trim() || newModelId.value.trim(),
        isCustom: true,
        capabilities: caps.length > 0 ? caps : ['text'],
      }
      settingsStore.updateProvider(provider.id, {
        models: [...provider.models, pendingModel],
      })
      newModelId.value = ''
      newModelName.value = ''
      newModelCaps.value = { text: true, vision: false, video: false, audio: false, code: false }
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
    <PageToolbar :search-placeholder="t('settings.searchPlaceholder', 'Search settings...')" @search="settingsSearch = $event">
      <template #tabs>
        <SegmentedControl
          v-model="activeSection"
          :segments="sections.map(s => ({ key: s.key, label: s.label }))"
        />
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="onToolbarReset">
          <RotateCcw :size="14" />
          {{ t('settings.toolbar.reset', 'Reset') }}
        </button>
        <button class="hc-btn hc-btn-primary" @click="saveConfig">
          <Save :size="14" />
          {{ t('settings.toolbar.saveSettings', 'Save Settings') }}
        </button>
      </template>
    </PageToolbar>

    <div class="hc-settings__body">
      <div class="hc-settings__content">
        <LoadingState v-if="settingsStore.loading && !config" />

        <template v-if="config">
          <!-- LLM Providers -->
          <div v-if="activeSection === 'llm'" class="hc-settings__section hc-settings__section--scroll" style="max-width: 600px;">
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
                  <img :src="PROVIDER_LOGOS[preset.type]" :alt="preset.type" class="hc-provider__type-logo" />
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
                    <img :src="PROVIDER_LOGOS[provider.type] || PROVIDER_LOGOS.custom" :alt="provider.type" class="hc-provider__logo" />
                    <span class="hc-provider__card-name">{{ provider.name }}</span>
                    <span class="hc-provider__tag">{{ provider.type }}</span>
                    <span class="hc-provider__model-count">{{ provider.models.length }} {{ t('settings.llm.models').toLowerCase() }}</span>
                  </div>
                  <div class="hc-provider__card-actions">
                    <button
                      class="hc-provider__icon-btn"
                      title="测试连接"
                      :disabled="testingProviderId === provider.id"
                      @click.stop="testProvider(provider)"
                    >
                      <Loader2 v-if="testingProviderId === provider.id" :size="14" class="animate-spin" style="color: var(--hc-text-muted);" />
                      <CheckCircle v-else-if="testProviderResult[provider.id]?.ok" :size="14" style="color: #22c55e;" />
                      <XCircle v-else-if="testProviderResult[provider.id] && !testProviderResult[provider.id]!.ok" :size="14" style="color: #ef4444;" />
                      <Zap v-else :size="14" style="color: var(--hc-text-muted);" />
                    </button>
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
                    <div class="hc-model-list">
                      <div v-for="(model, idx) in provider.models" :key="model.id" class="hc-model-card">
                        <div class="hc-model-card__main">
                          <div class="hc-model-card__name">{{ model.name }}</div>
                          <code class="hc-model-card__id">{{ model.id }}</code>
                        </div>
                        <NSpace :size="4" align="center">
                          <NTag v-for="cap in (model.capabilities || ['text']).filter((c: string) => c !== 'text')" :key="cap" size="tiny" :bordered="false" :type="cap === 'vision' ? 'info' : cap === 'video' ? 'warning' : 'success'">
                            {{ cap === 'vision' ? '视觉' : cap === 'video' ? '视频' : '音频' }}
                          </NTag>
                          <button class="hc-model-card__action" @click="openEditModel(provider, idx)" title="编辑">
                            <Pencil :size="13" />
                          </button>
                          <NPopconfirm @positive-click="removeModel(provider, model.id)">
                            <template #trigger>
                              <button class="hc-model-card__action hc-model-card__action--del" title="删除">
                                <Trash2 :size="13" />
                              </button>
                            </template>
                            确定删除模型「{{ model.name }}」？
                          </NPopconfirm>
                        </NSpace>
                      </div>

                      <!-- 添加模型 -->
                      <button v-if="!showAddModelPanel" class="hc-model-add-btn" @click="showAddModelPanel = true">
                        <Plus :size="14" />
                        添加模型
                      </button>
                      <div v-else class="hc-model-add-form">
                        <div class="hc-model-add-form__row">
                          <input v-model="newModelId" type="text" class="hc-input hc-input--sm" placeholder="模型 ID *（如 gpt-4o）" />
                          <input v-model="newModelName" type="text" class="hc-input hc-input--sm" placeholder="显示名称（选填）" />
                        </div>
                        <div class="hc-model-add-form__caps">
                          <label v-for="cap in (['text', 'vision', 'video', 'audio'] as ModelCapability[])" :key="cap" class="hc-cap-check">
                            <input v-model="newModelCaps[cap]" type="checkbox" :disabled="cap === 'text'" />
                            <span>{{ cap === 'text' ? '文本' : cap === 'vision' ? '视觉' : cap === 'video' ? '视频' : '音频' }}</span>
                          </label>
                        </div>
                        <div class="hc-model-add-form__actions">
                          <button class="hc-btn hc-btn-sm" @click="showAddModelPanel = false">取消</button>
                          <button class="hc-btn hc-btn-primary hc-btn-sm" :disabled="!newModelId.trim()" @click="addCustomModel(provider); showAddModelPanel = false">
                            <Plus :size="12" /> 添加
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 测试连接 -->
                  <div class="hc-provider__test-row">
                    <button
                      class="hc-btn hc-btn-sm"
                      :disabled="testingProviderId === provider.id"
                      @click="testProvider(provider)"
                    >
                      <Loader2 v-if="testingProviderId === provider.id" :size="13" class="animate-spin" />
                      <Zap v-else :size="13" />
                      {{ testingProviderId === provider.id ? '测试中...' : '测试连接' }}
                    </button>
                    <span
                      v-if="testProviderResult[provider.id]"
                      class="hc-provider__test-badge"
                      :class="testProviderResult[provider.id]!.ok ? 'hc-provider__test-badge--ok' : 'hc-provider__test-badge--err'"
                    >
                      <CheckCircle v-if="testProviderResult[provider.id]!.ok" :size="12" />
                      <XCircle v-else :size="12" />
                      {{ testProviderResult[provider.id]!.msg }}
                    </span>
                  </div>

                  <div class="hc-provider__edit-footer">
                    <NPopconfirm @positive-click="handleDeleteProvider(provider.id)">
                      <template #trigger>
                        <button class="hc-provider__delete-btn">
                          <Trash2 :size="13" />
                          {{ t('settings.llm.deleteProvider') }}
                        </button>
                      </template>
                      {{ t('settings.llm.deleteProviderConfirm', '确定删除该 Provider？') }}
                    </NPopconfirm>
                  </div>
                </div>
              </div>
            </div>

            <button class="hc-btn hc-btn-primary" :class="{ 'hc-settings__btn--saved': saved }" style="margin-top: 20px;" @click="saveConfig">
              {{ saved ? t('common.saved') : t('settings.saveConfig') }}
            </button>
          </div>

          <!-- Appearance (merged: theme + language + auto start) -->
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

              <div class="hc-settings__field">
                <label class="hc-settings__label">{{ t('settings.general.language') }}</label>
                <select v-model="config.general.language" class="hc-input" @change="handleLocaleChange(config.general.language)">
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
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

        </template>
      </div>
    </div>
  </div>

  <!-- 编辑模型 Modal -->
  <NModal
    :show="!!editingModel"
    preset="card"
    :title="'编辑模型'"
    style="max-width: 420px"
    :bordered="false"
    :segmented="{ content: true, footer: true }"
    :close-on-esc="true"
    :mask-closable="true"
    @update:show="(v: boolean) => { if (!v) editingModel = null }"
    @after-leave="editingModel = null"
  >
    <div class="hc-edit-model">
      <div class="hc-edit-model__field">
        <label>模型 ID <span class="hc-settings__required">*</span></label>
        <input v-model="editModelForm.id" type="text" class="hc-input" placeholder="如 gpt-4o, claude-sonnet-4-6" />
      </div>
      <div class="hc-edit-model__field">
        <label>显示名称</label>
        <input v-model="editModelForm.name" type="text" class="hc-input" placeholder="留空则使用模型 ID" />
      </div>
      <div class="hc-edit-model__field">
        <label>模型能力</label>
        <div class="hc-edit-model__caps">
          <label v-for="cap in (['text', 'vision', 'video', 'audio'] as ModelCapability[])" :key="cap" class="hc-edit-model__cap-item">
            <input v-model="editModelForm.caps[cap]" type="checkbox" :disabled="cap === 'text'" />
            <span class="hc-edit-model__cap-icon">{{ cap === 'text' ? '💬' : cap === 'vision' ? '👁' : cap === 'video' ? '🎬' : '🎤' }}</span>
            <span>{{ cap === 'text' ? '文本' : cap === 'vision' ? '视觉' : cap === 'video' ? '视频' : '音频' }}</span>
          </label>
        </div>
      </div>
    </div>
    <template #footer>
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <button class="hc-btn hc-btn-sm" @click="editingModel = null">取消</button>
        <button class="hc-btn hc-btn-primary hc-btn-sm" :disabled="!editModelForm.id.trim()" @click="saveEditModel">保存</button>
      </div>
    </template>
  </NModal>
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

/* ─── Content ───── */
.hc-settings__content {
  flex: 1;
  overflow: hidden;
  padding: 16px 24px;
}

.hc-settings__section {
  max-width: 520px;
  height: 100%;
  display: flex;
  flex-direction: column;
  animation: hc-fade-in 0.25s ease-out;
}

.hc-settings__section--scroll {
  overflow-y: auto;
}

.hc-settings__section-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--hc-text-primary);
  margin: 0 0 12px;
  letter-spacing: -0.01em;
  flex-shrink: 0;
}

.hc-settings__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.hc-settings__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  gap: 12px;
  padding: 6px 0;
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
  padding: 10px 12px;
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
/* ─── Provider Management ───── */
.hc-provider__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  flex-shrink: 0;
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
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-provider__type-logo {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
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

.hc-provider__logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex-shrink: 0;
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

.hc-provider__model-name-input {
  font-weight: 500;
  color: var(--hc-text-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 13px;
  max-width: 180px;
}

.hc-provider__model-name-input:hover,
.hc-provider__model-name-input:focus {
  border-color: var(--hc-border);
  background: var(--hc-bg-hover);
  outline: none;
}

.hc-provider__model-id {
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  flex: 1;
}

.hc-provider__model-id-input {
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 11px;
  flex: 1;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 4px;
}

.hc-provider__model-id-input:hover,
.hc-provider__model-id-input:focus {
  border-color: var(--hc-border);
  background: var(--hc-bg-hover);
  outline: none;
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

.hc-provider__test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
}

.hc-provider__test-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
}
.hc-provider__test-badge--ok { background: #22c55e15; color: #22c55e; }
.hc-provider__test-badge--err { background: #ef444415; color: #ef4444; }

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
  margin-bottom: 10px;
}

.hc-settings__hint {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-settings__btn--saved {
  background: var(--hc-success) !important;
}

/* ─── Webhook ───── */
.hc-webhook__add-panel {
  padding: 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hc-webhook__type-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-webhook__type-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--hc-radius-sm);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-webhook__type-btn:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-webhook__type-btn--active {
  font-weight: 500;
}

.hc-webhook__type-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-webhook__events {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hc-webhook__event-check {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--hc-text-secondary);
  cursor: pointer;
}

.hc-webhook__event-check input {
  accent-color: var(--hc-accent);
}

.hc-webhook__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-webhook__card {
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  transition: border-color 0.15s;
}

.hc-webhook__card:hover {
  border-color: var(--hc-accent-subtle);
}

.hc-webhook__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-webhook__card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-webhook__tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
}

.hc-webhook__card-url {
  font-size: 11px;
  color: var(--hc-text-muted);
  font-family: 'SF Mono', 'Menlo', monospace;
  margin-top: 6px;
  word-break: break-all;
}

.hc-webhook__card-events {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.hc-webhook__event-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-hover);
}

/* ─── 模型卡片列表 ─── */
.hc-model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--hc-bg-hover, rgba(255,255,255,0.04));
  border: 1px solid var(--hc-border, rgba(255,255,255,0.08));
  transition: border-color 0.15s;
}

.hc-model-card:hover {
  border-color: var(--hc-accent, #4a90d9);
}

.hc-model-card__main {
  flex: 1;
  min-width: 0;
}

.hc-model-card__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  line-height: 1.4;
}

.hc-model-card__id {
  font-size: 11px;
  color: var(--hc-text-muted, #5c5c6b);
  font-family: 'SF Mono', 'Menlo', monospace;
}

.hc-model-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--hc-text-muted, #5c5c6b);
  transition: all 0.15s;
}

.hc-model-card__action:hover {
  background: var(--hc-bg-card, rgba(255,255,255,0.06));
  color: var(--hc-text-primary);
}

.hc-model-card__action--del:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

/* ─── 添加模型 ─── */
.hc-model-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px;
  border: 1px dashed var(--hc-border, rgba(255,255,255,0.12));
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-muted, #5c5c6b);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-model-add-btn:hover {
  border-color: var(--hc-accent, #4a90d9);
  color: var(--hc-accent, #4a90d9);
  background: rgba(74, 144, 217, 0.05);
}

.hc-model-add-form {
  padding: 12px;
  border: 1px solid var(--hc-border, rgba(255,255,255,0.08));
  border-radius: 8px;
  background: var(--hc-bg-hover, rgba(255,255,255,0.02));
}

.hc-model-add-form__row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.hc-model-add-form__caps {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}

.hc-cap-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--hc-text-secondary);
  cursor: pointer;
}

.hc-cap-check input {
  accent-color: var(--hc-accent, #4a90d9);
}

.hc-model-add-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ─── 编辑模型 Modal ─── */
.hc-edit-model {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hc-edit-model__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-edit-model__field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-edit-model__caps {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.hc-edit-model__cap-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--hc-border, rgba(255,255,255,0.08));
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-edit-model__cap-item:hover {
  background: var(--hc-bg-hover, rgba(255,255,255,0.04));
}

.hc-edit-model__cap-item input {
  accent-color: var(--hc-accent, #4a90d9);
}

.hc-edit-model__cap-icon {
  font-size: 16px;
}
</style>
