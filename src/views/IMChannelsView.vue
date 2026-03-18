<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Pencil, Zap, Eye, EyeOff, X, ExternalLink, Info, RotateCw } from 'lucide-vue-next'
import {
  getIMChannels,
  saveIMChannel,
  testIMChannel,
  getChannelMeta,
  getChannelHelpText,
  CHANNEL_CONFIG_FIELDS,
} from '@/api/im-channels'
import type { IMChannel, IMChannelType } from '@/api/im-channels'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t, locale } = useI18n()

const channels = ref<IMChannel[]>([])
const loading = ref(true)
const errorMsg = ref('')

// 编辑 Modal
const showModal = ref(false)
const editingType = ref<IMChannelType>('feishu')
const formEnabled = ref(false)
const formConfig = ref<Record<string, string>>({})
const formSaving = ref(false)
const showSecrets = ref<Record<string, boolean>>({})

// 测试连接
const testingType = ref<IMChannelType | null>(null)
const testResults = ref<Partial<Record<IMChannelType, { success: boolean; message: string }>>>({})

// 保存后重启提示
const showRestartBanner = ref(false)

// 每个通道的最后保存时间
const lastSaved = ref<Record<string, string>>({})

const isZh = computed(() => locale.value === 'zh-CN')

onMounted(loadChannels)

async function loadChannels() {
  loading.value = true
  errorMsg.value = ''
  try {
    channels.value = await getIMChannels()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载通道配置失败'
    console.error('加载通道配置失败:', e)
  } finally {
    loading.value = false
  }
}

function openEdit(channel: IMChannel) {
  editingType.value = channel.type
  formEnabled.value = channel.enabled
  formConfig.value = { ...channel.config }
  showSecrets.value = {}
  delete testResults.value[channel.type]
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  delete testResults.value[editingType.value]
}

async function handleSave() {
  formSaving.value = true
  try {
    const ok = await saveIMChannel(editingType.value, formEnabled.value, formConfig.value)
    if (ok) {
      lastSaved.value[editingType.value] = new Date().toISOString()
      closeModal()
      await loadChannels()
      showRestartBanner.value = true
    } else {
      errorMsg.value = '保存失败，请检查配置'
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    formSaving.value = false
  }
}

const restarting = ref(false)

async function restartEngine() {
  restarting.value = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_sidecar')
  } catch (e) {
    console.warn('重启 sidecar:', e)
  }
  showRestartBanner.value = false
  restarting.value = false
  await loadChannels()
}

function dismissRestartBanner() {
  showRestartBanner.value = false
}

function formatLastSaved(type: string): string {
  const ts = lastSaved.value[type]
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function handleTest(type: IMChannelType) {
  testingType.value = type
  delete testResults.value[type]
  try {
    testResults.value[type] = await testIMChannel(type)
  } catch (e) {
    testResults.value[type] = { success: false, message: e instanceof Error ? e.message : '测试失败' }
  } finally {
    testingType.value = null
  }
}

async function handleToggle(channel: IMChannel) {
  try {
    await saveIMChannel(channel.type, !channel.enabled, channel.config)
    await loadChannels()
    showRestartBanner.value = true
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '更新失败'
  }
}

function toggleSecret(key: string) {
  showSecrets.value[key] = !showSecrets.value[key]
}

function getStatusColor(ch: IMChannel) {
  return ch.enabled ? 'var(--hc-success)' : 'var(--hc-text-muted)'
}

function getStatusText(ch: IMChannel) {
  if (ch.enabled) {
    const hasConfig = Object.values(ch.config).some(v => v.trim())
    return hasConfig ? (isZh.value ? '已启用' : 'Enabled') : (isZh.value ? '待配置' : 'Needs Config')
  }
  return isZh.value ? '未启用' : 'Disabled'
}

const configFields = computed(() => CHANNEL_CONFIG_FIELDS[editingType.value] || [])
const currentMeta = computed(() => getChannelMeta(editingType.value))
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="isZh ? 'IM 通道' : 'IM Channels'" :description="isZh ? '连接即时通讯平台，随时随地与 AI 对话' : 'Connect IM platforms to chat with AI anywhere'">
      <template #actions>
        <button class="hc-im-btn hc-im-btn--ghost" @click="loadChannels">
          <RefreshCw :size="14" />
          {{ t('common.retry') }}
        </button>
      </template>
    </PageHeader>

    <div v-if="errorMsg" class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between" style="background: #ef444420; color: #ef4444;">
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <!-- 保存后重启提示 -->
    <div v-if="showRestartBanner" class="mx-6 mt-2 px-4 py-2.5 rounded-lg text-sm flex items-center gap-3" style="background: #3b82f620; color: #3b82f6;">
      <Info :size="16" class="shrink-0" />
      <span class="flex-1">{{ isZh ? '配置已保存。需要重启 Engine 生效。' : 'Config saved. Restart Engine to apply changes.' }}</span>
      <button
        class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium"
        style="background: #3b82f6; color: #fff;"
        :disabled="restarting"
        @click="restartEngine"
      >
        <RotateCw :size="12" :class="{ 'animate-spin': restarting }" />
        {{ restarting ? (isZh ? '重启中...' : 'Restarting...') : (isZh ? '重启 Engine' : 'Restart Engine') }}
      </button>
      <button class="text-xs opacity-60 hover:opacity-100" @click="dismissRestartBanner">
        {{ isZh ? '稍后' : 'Later' }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <div v-else class="hc-im-grid">
        <div v-for="channel in channels" :key="channel.type" class="hc-im-card" :class="{ 'hc-im-card--enabled': channel.enabled }">
          <div class="hc-im-card__header">
            <div class="hc-im-card__icon" :style="{ background: getChannelMeta(channel.type).color + '18' }">
              <img :src="getChannelMeta(channel.type).logo" :alt="getChannelMeta(channel.type).name" class="hc-im-card__logo" />
            </div>
            <div class="hc-im-card__info">
              <div class="hc-im-card__name">{{ isZh ? getChannelMeta(channel.type).name : getChannelMeta(channel.type).nameEn }}</div>
            </div>
            <div class="hc-im-card__status">
              <span class="hc-im-card__dot" :style="{ background: getStatusColor(channel) }" />
              <span class="hc-im-card__status-text">{{ getStatusText(channel) }}</span>
            </div>
          </div>

          <div class="hc-im-card__actions">
            <label class="hc-im-toggle">
              <input type="checkbox" :checked="channel.enabled" @change="handleToggle(channel)" />
              <span class="hc-im-toggle__slider" />
            </label>
            <div class="hc-im-card__btns">
              <button class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm" :disabled="testingType === channel.type" @click="handleTest(channel.type)">
                <Zap :size="13" />
                {{ testingType === channel.type ? '...' : (isZh ? '测试' : 'Test') }}
              </button>
              <button class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm" @click="openEdit(channel)">
                <Pencil :size="13" />
                {{ isZh ? '配置' : 'Config' }}
              </button>
            </div>
          </div>

          <div v-if="testResults[channel.type]" class="hc-im-card__test-result" :class="testResults[channel.type]!.success ? 'hc-im-card__test-result--ok' : 'hc-im-card__test-result--err'">
            {{ testResults[channel.type]!.message }}
          </div>

          <div v-if="lastSaved[channel.type]" class="hc-im-card__timestamp">
            {{ isZh ? '上次保存' : 'Last saved' }}: {{ formatLastSaved(channel.type) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑 Modal -->
    <Teleport to="body">
      <Transition name="hc-modal">
        <div v-if="showModal" class="hc-im-overlay" @click.self="closeModal">
          <div class="hc-im-modal">
            <div class="hc-im-modal__header">
              <h2 class="hc-im-modal__title"><img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-modal__logo" /> {{ isZh ? currentMeta.name : currentMeta.nameEn }} {{ isZh ? '配置' : 'Config' }}</h2>
              <button class="hc-im-btn hc-im-btn--ghost hc-im-btn--icon hc-im-btn--sm" @click="closeModal">
                <X :size="16" />
              </button>
            </div>

            <div class="hc-im-modal__body">
              <div class="hc-im-modal__type-header">
                <span class="hc-im-type-badge" :style="{ background: currentMeta.color + '20', color: currentMeta.color }">
                  <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-badge__logo" /> {{ isZh ? currentMeta.name : currentMeta.nameEn }}
                </span>
                <a :href="currentMeta.helpUrl" target="_blank" rel="noopener" class="hc-im-help-link">
                  <ExternalLink :size="12" />
                  {{ isZh ? '开发文档' : 'Docs' }}
                </a>
              </div>

              <!-- 平台配置说明 -->
              <div class="hc-im-help-box">
                <p class="hc-im-help-box__text">{{ getChannelHelpText(editingType, locale) }}</p>
              </div>

              <div v-for="field in configFields" :key="field.key" class="hc-im-field">
                <label class="hc-im-field__label">{{ isZh ? field.label : field.labelEn }}</label>
                <div class="hc-im-input-wrap">
                  <input
                    v-model="formConfig[field.key]"
                    :type="field.secret && !showSecrets[field.key] ? 'password' : 'text'"
                    class="hc-im-input"
                    :placeholder="field.placeholder"
                  />
                  <button v-if="field.secret" class="hc-im-input-eye" @click="toggleSecret(field.key)">
                    <component :is="showSecrets[field.key] ? EyeOff : Eye" :size="14" />
                  </button>
                </div>
              </div>

              <div class="hc-im-field hc-im-field--row">
                <label class="hc-im-field__label">{{ t('common.enable') }}</label>
                <label class="hc-im-toggle">
                  <input v-model="formEnabled" type="checkbox" />
                  <span class="hc-im-toggle__slider" />
                </label>
              </div>

              <div v-if="testResults[editingType]" class="hc-im-test-result" :class="testResults[editingType]!.success ? 'hc-im-test-result--ok' : 'hc-im-test-result--err'">
                {{ testResults[editingType]!.message }}
              </div>
            </div>

            <div class="hc-im-modal__footer">
              <button class="hc-im-btn hc-im-btn--ghost" :disabled="testingType !== null" @click="handleTest(editingType)">
                <Zap :size="14" />
                {{ testingType ? '...' : (isZh ? '测试连接' : 'Test') }}
              </button>
              <div class="flex-1" />
              <button class="hc-im-btn hc-im-btn--ghost" @click="closeModal">{{ t('common.cancel') }}</button>
              <button class="hc-im-btn hc-im-btn--primary" :disabled="formSaving" @click="handleSave">
                {{ formSaving ? '...' : t('common.save') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-im-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  max-width: 1200px;
}

.hc-im-card {
  border-radius: var(--hc-radius-lg, 12px);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.2s;
}
.hc-im-card--enabled { border-color: var(--hc-accent); }
.hc-im-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.04); }

.hc-im-card__header { display: flex; align-items: center; gap: 12px; }
.hc-im-card__icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.hc-im-card__logo { width: 22px; height: 22px; object-fit: contain; }
.hc-im-modal__logo { width: 18px; height: 18px; object-fit: contain; vertical-align: middle; margin-right: 4px; }
.hc-im-badge__logo { width: 14px; height: 14px; object-fit: contain; vertical-align: middle; }
.hc-im-card__info { flex: 1; min-width: 0; }
.hc-im-card__name { font-size: 14px; font-weight: 600; color: var(--hc-text-primary); }
.hc-im-card__status { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.hc-im-card__dot { width: 7px; height: 7px; border-radius: 50%; }
.hc-im-card__status-text { font-size: 12px; color: var(--hc-text-muted); }

.hc-im-card__actions { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; border-top: 1px solid var(--hc-border); }
.hc-im-card__btns { display: flex; align-items: center; gap: 4px; }

.hc-im-card__test-result { font-size: 12px; padding: 6px 10px; border-radius: 6px; }
.hc-im-card__test-result--ok { background: #22c55e15; color: #22c55e; }
.hc-im-card__test-result--err { background: #ef444415; color: #ef4444; }

.hc-im-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; border: none; cursor: pointer; transition: background 0.15s, opacity 0.15s; white-space: nowrap; }
.hc-im-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.hc-im-btn--primary { background: var(--hc-accent); color: #fff; }
.hc-im-btn--primary:hover:not(:disabled) { opacity: 0.9; }
.hc-im-btn--ghost { background: var(--hc-bg-hover); color: var(--hc-text-secondary); }
.hc-im-btn--ghost:hover:not(:disabled) { background: var(--hc-bg-active); color: var(--hc-text-primary); }
.hc-im-btn--sm { padding: 4px 8px; font-size: 12px; }
.hc-im-btn--icon { padding: 4px; }

.hc-im-toggle { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
.hc-im-toggle input { opacity: 0; width: 0; height: 0; }
.hc-im-toggle__slider { position: absolute; inset: 0; background: var(--hc-bg-hover); border-radius: 10px; transition: background 0.2s; }
.hc-im-toggle__slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 2px; bottom: 2px; background: #fff; border-radius: 50%; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
.hc-im-toggle input:checked + .hc-im-toggle__slider { background: var(--hc-accent); }
.hc-im-toggle input:checked + .hc-im-toggle__slider::before { transform: translateX(16px); }

.hc-im-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.hc-im-modal { width: 480px; max-height: 85vh; border-radius: 16px; background: var(--hc-bg-main, #fff); border: 1px solid var(--hc-border); box-shadow: 0 20px 60px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden; }
.hc-im-modal__header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--hc-border); }
.hc-im-modal__title { font-size: 16px; font-weight: 600; color: var(--hc-text-primary); margin: 0; }
.hc-im-modal__body { flex: 1; overflow-y: auto; padding: 20px; }
.hc-im-modal__footer { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--hc-border); }
.hc-im-modal__type-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }

.hc-im-type-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 6px; }
.hc-im-help-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--hc-accent); text-decoration: none; }
.hc-im-help-link:hover { opacity: 0.8; }

.hc-im-field { margin-bottom: 14px; }
.hc-im-field--row { display: flex; align-items: center; justify-content: space-between; }
.hc-im-field__label { display: block; font-size: 13px; font-weight: 500; color: var(--hc-text-secondary); margin-bottom: 6px; }
.hc-im-field--row .hc-im-field__label { margin-bottom: 0; }

.hc-im-input-wrap { position: relative; }
.hc-im-input { width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--hc-border); background: var(--hc-bg-main); color: var(--hc-text-primary); font-size: 13px; outline: none; box-sizing: border-box; transition: border-color 0.15s; }
.hc-im-input:focus { border-color: var(--hc-accent); }
.hc-im-input::placeholder { color: var(--hc-text-muted); }
.hc-im-input-eye { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--hc-text-muted); cursor: pointer; padding: 2px; display: flex; }
.hc-im-input-wrap .hc-im-input { padding-right: 32px; }

.hc-im-card__timestamp { font-size: 11px; color: var(--hc-text-muted); padding-top: 2px; }

.hc-im-help-box { margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; background: var(--hc-bg-hover); }
.hc-im-help-box__text { font-size: 12px; color: var(--hc-text-secondary); line-height: 1.6; margin: 0; }

.hc-im-test-result { font-size: 13px; padding: 8px 12px; border-radius: 8px; margin-top: 4px; }
.hc-im-test-result--ok { background: #22c55e15; color: #22c55e; }
.hc-im-test-result--err { background: #ef444415; color: #ef4444; }

.hc-modal-enter-active, .hc-modal-leave-active { transition: opacity 0.2s ease; }
.hc-modal-enter-active .hc-im-modal, .hc-modal-leave-active .hc-im-modal { transition: transform 0.2s ease, opacity 0.2s ease; }
.hc-modal-enter-from, .hc-modal-leave-to { opacity: 0; }
.hc-modal-enter-from .hc-im-modal, .hc-modal-leave-to .hc-im-modal { transform: scale(0.95); opacity: 0; }
</style>
