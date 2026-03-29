<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus,
  Search,
  Pencil,
  Zap,
  Trash2,
  Eye,
  EyeOff,
  X,
  ExternalLink,
  Info,
  RotateCw,
  MessageSquare,
} from 'lucide-vue-next'
import {
  getIMInstances,
  createIMInstance,
  updateIMInstance,
  deleteIMInstance,
  testIMInstance,
  testSavedIMInstanceRuntime,
  startIMInstance,
  stopIMInstance,
  listIMInstancesHealth,
  getChannelMeta,
  getChannelHelpText,
  getRequiredFieldLabels,
  getPlatformHookUrl,
  CHANNEL_TYPES,
  CHANNEL_CONFIG_FIELDS,
} from '@/api/im-channels'
import type { IMInstance, IMChannelType, IMInstanceHealth } from '@/api/im-channels'
import { setClipboard } from '@/api/desktop'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t, locale } = useI18n()

const instances = ref<IMInstance[]>([])
const loading = ref(true)
const errorMsg = ref('')
const searchQuery = ref('')

const filteredInstances = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return instances.value
  return instances.value.filter((inst) => {
    const meta = getChannelMeta(inst.type)
    return (
      inst.name.toLowerCase().includes(q) ||
      meta.name.toLowerCase().includes(q) ||
      meta.nameEn.toLowerCase().includes(q) ||
      inst.type.toLowerCase().includes(q)
    )
  })
})

// ─── Modal state ─────────────────────────────────────

const showModal = ref(false)
const modalMode = ref<'create' | 'edit'>('create')
const modalStep = ref<1 | 2>(1)
const editingId = ref<string | null>(null)
const formType = ref<IMChannelType>('feishu')
const formName = ref('')
const formEnabled = ref(false)
const formConfig = ref<Record<string, string>>({})
const formSaving = ref(false)
const showSecrets = ref<Record<string, boolean>>({})

const configFields = computed(() => CHANNEL_CONFIG_FIELDS[formType.value] || [])
const currentMeta = computed(() => getChannelMeta(formType.value))

function normalizeInstanceName(name: string): string {
  return name.trim().toLowerCase()
}

function suggestUniqueInstanceName(baseName: string): string {
  const trimmedBaseName = baseName.trim()
  if (!trimmedBaseName) return ''

  const usedNames = new Set(instances.value.map(instance => normalizeInstanceName(instance.name)))
  if (!usedNames.has(normalizeInstanceName(trimmedBaseName))) {
    return trimmedBaseName
  }

  let index = 2
  while (usedNames.has(normalizeInstanceName(`${trimmedBaseName} ${index}`))) {
    index += 1
  }
  return `${trimmedBaseName} ${index}`
}

// ─── Test connection ─────────────────────────────────

const testingId = ref<string | null>(null)
const testResults = ref<Record<string, { success: boolean; message: string }>>({})
const modalTestResult = ref<{ success: boolean; message: string } | null>(null)
const modalTesting = ref(false)

// ─── Instance health ────────────────────────────────

const healthMap = ref<Record<string, IMInstanceHealth>>({})
const togglingId = ref<string | null>(null)

async function loadHealth() {
  try {
    const list = await listIMInstancesHealth()
    const map: Record<string, IMInstanceHealth> = {}
    for (const h of list) map[h.name] = h
    healthMap.value = map
  } catch { /* non-critical */ }
}

function getHealth(inst: IMInstance): IMInstanceHealth | undefined {
  return healthMap.value[inst.name]
}

async function handleStartStop(inst: IMInstance) {
  const health = getHealth(inst)
  const isRunning = health?.status === 'running'
  togglingId.value = inst.id
  try {
    if (isRunning) {
      await stopIMInstance(inst.name)
    } else {
      await startIMInstance(inst.name)
    }
    await loadHealth()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.updateFailed')
  } finally {
    togglingId.value = null
  }
}

// ─── Delete confirmation ─────────────────────────────

const deletingId = ref<string | null>(null)

// ─── Restart banner ──────────────────────────────────

const showRestartBanner = ref(false)
const restarting = ref(false)

// ─── Lifecycle ───────────────────────────────────────

onMounted(loadInstances)

async function loadInstances() {
  loading.value = true
  errorMsg.value = ''
  try {
    instances.value = await getIMInstances()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.loadFailed')
  } finally {
    loading.value = false
  }
  loadHealth() // keep health status in sync
}

// ─── Create ──────────────────────────────────────────

function openCreate() {
  modalMode.value = 'create'
  modalStep.value = 1
  editingId.value = null
  formType.value = 'feishu'
  formName.value = ''
  formEnabled.value = false
  formConfig.value = {}
  showSecrets.value = {}
  modalTestResult.value = null
  showModal.value = true
}

function selectType(type: IMChannelType) {
  formType.value = type
  const meta = getChannelMeta(type)
  formName.value = suggestUniqueInstanceName(locale.value === 'zh-CN' ? meta.name : meta.nameEn)
  formConfig.value = {}
  formEnabled.value = false
  modalTestResult.value = null
  modalStep.value = 2
}

async function handleCreate() {
  formSaving.value = true
  try {
    await createIMInstance(
      formName.value.trim() || currentMeta.value.name,
      formType.value,
      formConfig.value,
      formEnabled.value,
    )
    closeModal()
    await loadInstances()
    showRestartBanner.value = true
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.createFailed')
  } finally {
    formSaving.value = false
  }
}

// ─── Edit ────────────────────────────────────────────

function openEdit(inst: IMInstance) {
  modalMode.value = 'edit'
  modalStep.value = 2
  editingId.value = inst.id
  formType.value = inst.type
  formName.value = inst.name
  formEnabled.value = inst.enabled
  formConfig.value = { ...inst.config }
  showSecrets.value = {}
  modalTestResult.value = null
  showModal.value = true
}

async function handleUpdate() {
  if (!editingId.value) return
  formSaving.value = true
  try {
    const ok = await updateIMInstance(editingId.value, {
      name: formName.value.trim() || currentMeta.value.name,
      enabled: formEnabled.value,
      config: formConfig.value,
    })
    if (ok) {
      closeModal()
      await loadInstances()
      showRestartBanner.value = true
    } else {
      errorMsg.value = t('imChannels.saveFailedCheck')
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.saveFailed')
  } finally {
    formSaving.value = false
  }
}

function handleSave() {
  if (modalMode.value === 'create') handleCreate()
  else handleUpdate()
}

function closeModal() {
  showModal.value = false
  modalTestResult.value = null
}

// ─── Toggle enable/disable ───────────────────────────

async function handleToggle(inst: IMInstance) {
  if (!inst.enabled && isConfigIncomplete(inst)) {
    errorMsg.value = t('imChannels.enableNeedConfig')
    await loadInstances() // force checkbox revert
    return
  }
  try {
    await updateIMInstance(inst.id, { enabled: !inst.enabled })
    await loadInstances()
    showRestartBanner.value = true
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.updateFailed')
    await loadInstances() // force checkbox revert to backend state
  }
}

// ─── Test connection ─────────────────────────────────

async function handleTestCard(inst: IMInstance) {
  testingId.value = inst.id
  delete testResults.value[inst.id]
  try {
    testResults.value[inst.id] = await testSavedIMInstanceRuntime(inst)
  } catch (e) {
    testResults.value[inst.id] = {
      success: false,
      message: e instanceof Error ? e.message : t('imChannels.testFailed'),
    }
  } finally {
    testingId.value = null
  }
}

async function handleTestModal() {
  modalTesting.value = true
  modalTestResult.value = null
  const tempInstance: IMInstance = {
    id: editingId.value || '__test__',
    name: formName.value,
    type: formType.value,
    enabled: formEnabled.value,
    config: formConfig.value,
    createdAt: Date.now(),
  }
  try {
    if (modalMode.value === 'edit' && editingId.value) {
      modalTestResult.value = await testSavedIMInstanceRuntime(tempInstance)
    } else {
      modalTestResult.value = await testIMInstance(tempInstance)
    }
  } catch (e) {
    modalTestResult.value = {
      success: false,
      message: e instanceof Error ? e.message : t('imChannels.testFailed'),
    }
  } finally {
    modalTesting.value = false
  }
}

// ─── Delete ──────────────────────────────────────────

function confirmDelete(id: string) {
  deletingId.value = id
}

function cancelDelete() {
  deletingId.value = null
}

async function handleDelete(id: string) {
  try {
    await deleteIMInstance(id)
    deletingId.value = null
    delete testResults.value[id]
    await loadInstances()
    showRestartBanner.value = true
  } catch (e) {
    deletingId.value = null // close overlay so user isn't stuck
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.deleteFailed')
  }
}

// ─── Restart engine ──────────────────────────────────

async function restartEngine() {
  restarting.value = true
  try {
    const { useAppStore } = await import('@/stores/app')
    await useAppStore().restartSidecar()
  } catch (e) {
    console.warn('重启 sidecar:', e)
  }
  showRestartBanner.value = false
  restarting.value = false
  await loadInstances()
}

function dismissRestartBanner() {
  showRestartBanner.value = false
}

// ─── Helpers ─────────────────────────────────────────

function toggleSecret(key: string) {
  showSecrets.value[key] = !showSecrets.value[key]
}

function isConfigIncomplete(inst: IMInstance): boolean {
  return getRequiredFieldLabels(inst).length > 0
}

function getStatusText(inst: IMInstance) {
  if (inst.enabled && isConfigIncomplete(inst)) return t('imChannels.configIncomplete')
  if (inst.enabled) return t('imChannels.running')
  return t('imChannels.disabled')
}

async function copyWebhookUrl() {
  const text = getPlatformHookUrl({ name: formName.value, type: formType.value })
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      await setClipboard(text)
    }
  } catch {
    await setClipboard(text)
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('imChannels.title')" :description="t('imChannels.description')">
      <template #actions>
        <div class="hc-im-search-wrap">
          <Search :size="14" class="hc-im-search-icon" />
          <input
            v-model="searchQuery"
            class="hc-im-search"
            :placeholder="t('imChannels.searchPlaceholder')"
          />
        </div>
        <button v-if="instances.length > 0" class="hc-im-btn hc-im-btn--accent" @click="openCreate">
          <Plus :size="14" />
          {{ t('imChannels.newInstance') }}
        </button>
      </template>
    </PageHeader>

    <!-- Error message -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: color-mix(in srgb, var(--hc-error) 12%, transparent); color: var(--hc-error)"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">
        {{ t('common.close') }}
      </button>
    </div>

    <!-- Restart banner -->
    <div
      v-if="showRestartBanner"
      class="mx-6 mt-2 px-4 py-2.5 rounded-lg text-sm flex items-center gap-3"
      style="background: color-mix(in srgb, var(--hc-accent) 12%, transparent); color: var(--hc-accent)"
    >
      <Info :size="16" class="shrink-0" />
      <span class="flex-1">
        {{ t('imChannels.configUpdated') }}
      </span>
      <button
        class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium"
        style="background: var(--hc-accent); color: var(--hc-text-inverse)"
        :disabled="restarting"
        @click="restartEngine"
      >
        <RotateCw :size="12" :class="{ 'animate-spin': restarting }" />
        {{ restarting ? t('imChannels.restarting') : t('imChannels.restartEngine') }}
      </button>
      <button class="text-xs opacity-60 hover:opacity-100" @click="dismissRestartBanner">
        {{ t('imChannels.later') }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- Empty state -->
      <div v-else-if="instances.length === 0" class="hc-im-empty">
        <div class="hc-im-empty__icon">
          <MessageSquare :size="36" />
        </div>
        <h3 class="hc-im-empty__title">{{ t('imChannels.noChannels') }}</h3>
        <p class="hc-im-empty__desc">
          {{ t('imChannels.noChannelsDesc') }}
        </p>
        <button class="hc-im-btn hc-im-btn--accent" @click="openCreate">
          <Plus :size="14" />
          {{ t('imChannels.newInstance') }}
        </button>
      </div>

      <!-- No search results -->
      <div v-else-if="filteredInstances.length === 0 && searchQuery.trim()" class="hc-im-empty">
        <div class="hc-im-empty__icon hc-im-empty__icon--muted">
          <Search :size="32" />
        </div>
        <h3 class="hc-im-empty__title">{{ t('imChannels.noMatching') }}</h3>
        <p class="hc-im-empty__desc">
          {{ t('imChannels.tryDifferentSearch') }}
        </p>
      </div>

      <!-- Instance card grid -->
      <div v-else class="hc-im-grid">
        <div
          v-for="inst in filteredInstances"
          :key="inst.id"
          class="hc-im-card"
          :class="{ 'hc-im-card--enabled': inst.enabled }"
        >
          <!-- Delete inline confirmation overlay -->
          <div v-if="deletingId === inst.id" class="hc-im-card__delete-overlay">
            <p class="hc-im-card__delete-text">
              {{ t('imChannels.deleteInstanceConfirm') }}
            </p>
            <div class="hc-im-card__delete-actions">
              <button class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm" @click="cancelDelete">
                {{ t('common.cancel') }}
              </button>
              <button
                class="hc-im-btn hc-im-btn--danger hc-im-btn--sm"
                @click="handleDelete(inst.id)"
              >
                <Trash2 :size="12" />
                {{ t('imChannels.confirmDelete') }}
              </button>
            </div>
          </div>

          <!-- Card header -->
          <div class="hc-im-card__header">
            <div
              class="hc-im-card__icon"
              :style="{ background: getChannelMeta(inst.type).color + '18' }"
            >
              <img
                :src="getChannelMeta(inst.type).logo"
                :alt="getChannelMeta(inst.type).name"
                class="hc-im-card__logo"
              />
            </div>
            <div class="hc-im-card__info">
              <div class="hc-im-card__name">{{ inst.name }}</div>
            </div>
            <div class="hc-im-card__status">
              <span
                class="hc-im-card__dot"
                :style="{
                  background:
                    inst.enabled && isConfigIncomplete(inst)
                      ? 'var(--hc-warning)'
                      : inst.enabled
                        ? 'var(--hc-success)'
                        : 'var(--hc-text-muted)',
                }"
              />
              <span class="hc-im-card__status-text">{{ getStatusText(inst) }}</span>
            </div>
          </div>

          <!-- Details row: platform type badge -->
          <div class="hc-im-card__details">
            <span
              class="hc-im-type-badge"
              :style="{
                background: getChannelMeta(inst.type).color + '20',
                color: getChannelMeta(inst.type).color,
              }"
            >
              <img
                :src="getChannelMeta(inst.type).logo"
                :alt="getChannelMeta(inst.type).name"
                class="hc-im-badge__logo"
              />
              {{
                locale === 'zh-CN'
                  ? getChannelMeta(inst.type).name
                  : getChannelMeta(inst.type).nameEn
              }}
            </span>
          </div>

          <!-- Runtime status row -->
          <div v-if="inst.enabled && getHealth(inst)" class="hc-im-card__runtime">
            <span
              class="hc-im-card__runtime-dot"
              :class="{
                'hc-im-card__runtime-dot--running': getHealth(inst)?.status === 'running',
                'hc-im-card__runtime-dot--error': getHealth(inst)?.status === 'error',
              }"
            />
            <span class="hc-im-card__runtime-text">
              {{ getHealth(inst)?.status === 'running' ? t('imChannels.statusRunning') : getHealth(inst)?.status === 'error' ? (getHealth(inst)?.last_error || t('imChannels.statusError')) : t('imChannels.statusStopped') }}
            </span>
            <button
              class="hc-im-btn hc-im-btn--ghost hc-im-btn--xs"
              :disabled="togglingId === inst.id"
              @click="handleStartStop(inst)"
            >
              {{ togglingId === inst.id ? '...' : getHealth(inst)?.status === 'running' ? t('imChannels.stop') : t('imChannels.start') }}
            </button>
          </div>

          <!-- Actions row -->
          <div class="hc-im-card__actions">
            <label class="hc-im-toggle">
              <input type="checkbox" :checked="inst.enabled" @change="handleToggle(inst)" />
              <span class="hc-im-toggle__slider" />
            </label>
            <div class="hc-im-card__btns">
              <button
                class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm"
                :disabled="testingId === inst.id"
                @click="handleTestCard(inst)"
              >
                <Zap :size="13" />
                {{ testingId === inst.id ? '...' : t('imChannels.test') }}
              </button>
              <button class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm" @click="openEdit(inst)">
                <Pencil :size="13" />
                {{ t('imChannels.config') }}
              </button>
              <button
                v-if="!inst.enabled"
                class="hc-im-btn hc-im-btn--ghost hc-im-btn--sm hc-im-btn--danger-text"
                @click="confirmDelete(inst.id)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </div>

          <!-- Test result -->
          <div
            v-if="testResults[inst.id]"
            class="hc-im-card__test-result"
            :class="
              testResults[inst.id]!.success
                ? 'hc-im-card__test-result--ok'
                : 'hc-im-card__test-result--err'
            "
          >
            {{ testResults[inst.id]!.message }}
          </div>
        </div>
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <Teleport to="body">
      <Transition name="hc-modal">
        <div v-if="showModal" class="hc-im-overlay" @click.self="closeModal">
          <div class="hc-im-modal">
            <!-- Modal header -->
            <div class="hc-im-modal__header">
              <h2 class="hc-im-modal__title">
                <template v-if="modalMode === 'create' && modalStep === 1">
                  {{ t('imChannels.newChannelInstance') }}
                </template>
                <template v-else-if="modalMode === 'create' && modalStep === 2">
                  <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-modal__logo" />
                  {{ t('imChannels.create') }}
                  {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
                </template>
                <template v-else>
                  <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-modal__logo" />
                  {{ t('common.edit') }}
                  {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
                </template>
              </h2>
              <button
                class="hc-im-btn hc-im-btn--ghost hc-im-btn--icon hc-im-btn--sm"
                @click="closeModal"
              >
                <X :size="16" />
              </button>
            </div>

            <!-- Step 1: select platform -->
            <div v-if="modalStep === 1" class="hc-im-modal__body">
              <p class="hc-im-modal__subtitle">
                {{ t('imChannels.selectPlatform') }}
              </p>
              <div class="hc-im-type-grid">
                <button
                  v-for="ch in CHANNEL_TYPES"
                  :key="ch.type"
                  class="hc-im-type-card"
                  @click="selectType(ch.type)"
                >
                  <div class="hc-im-type-card__icon" :style="{ background: ch.color + '18' }">
                    <img :src="ch.logo" :alt="ch.name" class="hc-im-type-card__logo" />
                  </div>
                  <span class="hc-im-type-card__name">{{
                    locale === 'zh-CN' ? ch.name : ch.nameEn
                  }}</span>
                </button>
              </div>
            </div>

            <!-- Step 2: configure -->
            <div v-else class="hc-im-modal__body">
              <div class="hc-im-modal__type-header">
                <span
                  class="hc-im-type-badge"
                  :style="{ background: currentMeta.color + '20', color: currentMeta.color }"
                >
                  <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-badge__logo" />
                  {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
                </span>
                <a
                  :href="currentMeta.helpUrl"
                  target="_blank"
                  rel="noopener"
                  class="hc-im-help-link"
                >
                  <ExternalLink :size="12" />
                  {{ t('imChannels.helpDocs') }}
                </a>
              </div>

              <!-- Help box -->
              <div class="hc-im-help-box">
                <p class="hc-im-help-box__text">{{ getChannelHelpText(formType, locale) }}</p>
              </div>

              <!-- ─── Credential fields ─── -->

                <!-- Instance name -->
                <div class="hc-im-field">
                  <label class="hc-im-field__label">{{ t('imChannels.instanceName') }}</label>
                  <input
                    v-model="formName"
                    class="hc-im-input"
                    :placeholder="t('imChannels.instanceNamePlaceholder')"
                  />
                </div>

                <!-- Config fields -->
                <div v-for="field in configFields" :key="field.key" class="hc-im-field">
                  <label class="hc-im-field__label">
                    {{ locale === 'zh-CN' ? field.label : field.labelEn }}
                  </label>
                  <div class="hc-im-input-wrap">
                    <input
                      v-model="formConfig[field.key]"
                      :type="field.secret && !showSecrets[field.key] ? 'password' : 'text'"
                      class="hc-im-input"
                      :placeholder="field.placeholder"
                    />
                    <button
                      v-if="field.secret"
                      class="hc-im-input-eye"
                      @click="toggleSecret(field.key)"
                    >
                      <component :is="showSecrets[field.key] ? EyeOff : Eye" :size="14" />
                    </button>
                  </div>
                </div>

                <!-- Enable toggle -->
                <div class="hc-im-field hc-im-field--row">
                  <label class="hc-im-field__label">{{ t('common.enable') }}</label>
                  <label class="hc-im-toggle">
                    <input v-model="formEnabled" type="checkbox" />
                    <span class="hc-im-toggle__slider" />
                  </label>
                </div>

                <!-- Webhook URL (only in edit mode with a saved name) -->
                <div v-if="modalMode === 'edit' && formName" class="hc-im-field">
                  <label class="hc-im-field__label">Webhook URL</label>
                  <div class="hc-im-webhook-url">
                    <code class="hc-im-webhook-url__text">{{ getPlatformHookUrl({ name: formName, type: formType }) }}</code>
                    <button
                      class="hc-im-webhook-url__copy"
                      :title="t('common.copy')"
                      @click="copyWebhookUrl"
                    >
                      {{ t('common.copy') }}
                    </button>
                  </div>
                </div>

            </div>

            <!-- Modal footer (sticky at bottom, never hidden by scroll) -->
            <div v-if="modalStep === 2" class="hc-im-modal__footer-wrap">
              <div
                v-if="modalTestResult"
                class="hc-im-test-result"
                :class="modalTestResult.success ? 'hc-im-test-result--ok' : 'hc-im-test-result--err'"
              >
                {{ modalTestResult.message }}
              </div>
              <div class="hc-im-modal__footer">
                  <button
                    class="hc-im-btn hc-im-btn--ghost"
                    :disabled="modalTesting"
                    @click="handleTestModal"
                  >
                    <Zap :size="14" />
                    {{ modalTesting ? '...' : t('imChannels.testConnection') }}
                  </button>
                  <div class="flex-1" />
                  <button
                    v-if="modalMode === 'create'"
                    class="hc-im-btn hc-im-btn--ghost"
                    @click="modalStep = 1"
                  >
                    {{ t('imChannels.back') }}
                  </button>
                  <button class="hc-im-btn hc-im-btn--ghost" @click="closeModal">
                    {{ t('common.cancel') }}
                  </button>
                  <button
                    class="hc-im-btn hc-im-btn--primary"
                    :disabled="formSaving"
                    @click="handleSave"
                  >
                    {{
                      formSaving
                        ? '...'
                        : modalMode === 'create'
                          ? t('common.create')
                          : t('common.save')
                    }}
                  </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Search ─────────────────────────────────────────── */

.hc-im-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.hc-im-search-icon {
  position: absolute;
  left: 10px;
  color: var(--hc-text-muted);
  pointer-events: none;
}

.hc-im-search {
  padding: 6px 10px 6px 30px;
  border-radius: 8px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-main);
  color: var(--hc-text-primary);
  font-size: 13px;
  width: 200px;
  outline: none;
  transition:
    border-color 0.15s,
    width 0.2s;
}

.hc-im-search:focus {
  border-color: var(--hc-accent);
  width: 240px;
}

.hc-im-search::placeholder {
  color: var(--hc-text-muted);
}

/* ── Empty state ────────────────────────────────────── */

.hc-im-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px;
  text-align: center;
}

.hc-im-empty__icon {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  opacity: 0.85;
}

.hc-im-empty__icon--muted {
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
}

.hc-im-empty__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0 0 8px;
}

.hc-im-empty__desc {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 0 0 24px;
  max-width: 360px;
  line-height: 1.6;
}

/* ── Grid ───────────────────────────────────────────── */

.hc-im-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  max-width: 1280px;
}

/* ── Card ───────────────────────────────────────────── */

.hc-im-card {
  position: relative;
  border-radius: var(--hc-radius-lg, 12px);
  border: 1px solid var(--hc-border);
  border-left: 2px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}

.hc-im-card--enabled {
  border-left-color: var(--hc-accent);
}

.hc-im-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
}

.hc-im-card__header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hc-im-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-im-card__logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.hc-im-card__info {
  flex: 1;
  min-width: 0;
}

.hc-im-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-im-card__status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hc-im-card__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.hc-im-card__status-text {
  font-size: 12px;
  color: var(--hc-text-muted);
}

.hc-im-card__details {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-im-card__runtime {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.hc-im-card__runtime-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-text-muted);
  flex-shrink: 0;
}
.hc-im-card__runtime-dot--running { background: var(--hc-success); }
.hc-im-card__runtime-dot--error { background: var(--hc-error); }
.hc-im-card__runtime-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hc-im-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--hc-border);
}

.hc-im-card__btns {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-im-card__test-result {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
}

.hc-im-card__test-result--ok {
  background: color-mix(in srgb, var(--hc-success) 8%, transparent);
  color: var(--hc-success);
}

.hc-im-card__test-result--err {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
}

/* ── Delete overlay ─────────────────────────────────── */

.hc-im-card__delete-overlay {
  position: absolute;
  inset: 0;
  background: var(--hc-bg-card, #1a1a2e);
  border-radius: var(--hc-radius-lg, 12px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  z-index: 2;
  opacity: 0.97;
}

.hc-im-card__delete-text {
  font-size: 14px;
  font-weight: 500;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-im-card__delete-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── Buttons ────────────────────────────────────────── */

.hc-im-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;
  white-space: nowrap;
}

.hc-im-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-im-btn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
}

.hc-im-btn--primary:hover:not(:disabled) {
  opacity: 0.9;
}

.hc-im-btn--accent {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
}

.hc-im-btn--accent:hover:not(:disabled) {
  opacity: 0.9;
}

.hc-im-btn--outline {
  background: transparent;
  color: var(--hc-accent);
  border: 1px solid var(--hc-accent);
}

.hc-im-btn--outline:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-accent) 8%, transparent);
}

.hc-im-btn--ghost {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-im-btn--ghost:hover:not(:disabled) {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
}

.hc-im-btn--danger {
  background: var(--hc-error);
  color: var(--hc-text-inverse);
}

.hc-im-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-error) 85%, black);
}

.hc-im-btn--danger-text {
  color: var(--hc-text-muted);
}

.hc-im-btn--danger-text:hover:not(:disabled) {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}

.hc-im-btn--sm {
  padding: 4px 8px;
  font-size: 12px;
}

.hc-im-btn--icon {
  padding: 4px;
}

/* ── Toggle ─────────────────────────────────────────── */

.hc-im-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}

.hc-im-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.hc-im-toggle__slider {
  position: absolute;
  inset: 0;
  background: var(--hc-bg-hover);
  border-radius: 10px;
  transition: background 0.2s;
}

.hc-im-toggle__slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--hc-text-inverse);
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.hc-im-toggle input:checked + .hc-im-toggle__slider {
  background: var(--hc-accent);
}

.hc-im-toggle input:checked + .hc-im-toggle__slider::before {
  transform: translateX(16px);
}

/* ── Type badge ─────────────────────────────────────── */

.hc-im-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 6px;
}

.hc-im-badge__logo {
  width: 14px;
  height: 14px;
  object-fit: contain;
  vertical-align: middle;
}

/* ── Modal ──────────────────────────────────────────── */

.hc-im-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.hc-im-modal {
  width: 520px;
  max-height: 95vh;
  border-radius: 16px;
  background: var(--hc-bg-main, #fff);
  border: 1px solid var(--hc-border);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-im-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-border);
}

.hc-im-modal__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-im-modal__logo {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.hc-im-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}

.hc-im-modal__subtitle {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 0 0 16px;
}

.hc-im-modal__footer-wrap {
  flex-shrink: 0;
  border-top: 1px solid var(--hc-border);
}

.hc-im-modal__footer-wrap .hc-im-test-result {
  margin: 12px 20px 0;
}

.hc-im-modal__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
}

.hc-im-modal__type-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

/* ── Type selection grid (Step 1) ───────────────────── */

.hc-im-type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.hc-im-type-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 12px;
  border-radius: 12px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}

.hc-im-type-card:hover {
  border-color: var(--hc-accent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}

.hc-im-type-card__icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hc-im-type-card__logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.hc-im-type-card__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}

/* ── Help ───────────────────────────────────────────── */

.hc-im-help-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--hc-accent);
  text-decoration: none;
}

.hc-im-help-link:hover {
  opacity: 0.8;
}

.hc-im-help-box {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--hc-bg-hover);
}

.hc-im-help-box__text {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.6;
  margin: 0;
}

/* ── Form fields ────────────────────────────────────── */

.hc-im-field {
  margin-bottom: 12px;
}

.hc-im-field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hc-im-field__label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  margin-bottom: 6px;
}

.hc-im-field--row .hc-im-field__label {
  margin-bottom: 0;
}

.hc-im-webhook-url {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  padding: 6px 10px;
}

.hc-im-webhook-url__text {
  flex: 1;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--hc-text-secondary);
  word-break: break-all;
  user-select: all;
}

.hc-im-webhook-url__copy {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  border: none;
  background: var(--hc-accent);
  color: white;
  cursor: pointer;
  transition: opacity 0.15s;
}

.hc-im-webhook-url__copy:hover {
  opacity: 0.85;
}

.hc-im-input-wrap {
  position: relative;
}

.hc-im-input {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-main);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.hc-im-input:focus {
  border-color: var(--hc-accent);
}

.hc-im-input::placeholder {
  color: var(--hc-text-muted);
}

.hc-im-input-eye {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--hc-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
}

.hc-im-input-wrap .hc-im-input {
  padding-right: 32px;
}

/* ── Test result (modal) ────────────────────────────── */

.hc-im-test-result {
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
}

.hc-im-test-result--ok {
  background: color-mix(in srgb, var(--hc-success) 8%, transparent);
  color: var(--hc-success);
}

.hc-im-test-result--err {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
}

/* ── Modal transitions ──────────────────────────────── */

.hc-modal-enter-active,
.hc-modal-leave-active {
  transition: opacity 0.2s ease;
}

.hc-modal-enter-active .hc-im-modal,
.hc-modal-leave-active .hc-im-modal {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}

.hc-modal-enter-from,
.hc-modal-leave-to {
  opacity: 0;
}

.hc-modal-enter-from .hc-im-modal,
.hc-modal-leave-to .hc-im-modal {
  transform: scale(0.95);
  opacity: 0;
}

.hc-spin {
  animation: hc-spin 1s linear infinite;
}
</style>
