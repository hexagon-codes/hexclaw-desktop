<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, RefreshCw, Sparkles } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useModelCatalogStore, AUTO_ENABLE_CATALOG_LIMIT } from '@/stores/model-catalog'
import {
  canonicalizeModelOption,
  isChatModelOption,
  resolveProviderSelectedModelId,
} from '@/config/model-contract'
import { isCatalogModelFree, catalogModelHasMetadata } from '@/types'
import type { CatalogModel, ModelCapability, ModelOption, ProviderConfig } from '@/types'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SearchInput from '@/components/common/SearchInput.vue'

/**
 * 模型管理器 — "目录 / 启用"两层架构的管理入口。
 *
 * 目录（catalog store，全量数百模型）在这里浏览、搜索、筛选；
 * 勾选的子集写入 provider.models（启用层），供聊天/智能体的模型选择器使用。
 */
const props = defineProps<{
  open: boolean
  provider: ProviderConfig
  syncing?: boolean
}>()

const emit = defineEmits<{
  close: []
  /** 启用列表变化，父组件负责 autoSave */
  change: []
  /** 请求重新同步目录 */
  resync: []
}>()

const { t, locale } = useI18n()
const settingsStore = useSettingsStore()
const catalogStore = useModelCatalogStore()

const search = ref('')
const view = ref('all')
const vendorFilter = ref('__all__')
const vendorSearch = ref('')
const capFilters = ref<Set<string>>(new Set())
const recDismissed = ref(false)
const clearArmed = ref(false)
let clearTimer: ReturnType<typeof setTimeout> | null = null
const searchInputRef = ref<InstanceType<typeof SearchInput> | null>(null)
const modalRef = ref<HTMLElement | null>(null)
const draftModels = ref<ModelOption[]>([])
const draftSelectedModelId = ref('')
const baselineModels = ref<ModelOption[]>([])
const baselineSelectedModelId = ref('')

const catalog = computed(() => catalogStore.getCatalog(props.provider.id))
const lastSuccessfulSyncAt = computed(() =>
  catalog.value?.source === 'remote' ? catalog.value.syncedAt : '',
)
const formattedLastSuccessfulSyncAt = computed(() => {
  if (!lastSuccessfulSyncAt.value) return ''
  const parsed = new Date(lastSuccessfulSyncAt.value)
  if (Number.isNaN(parsed.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
})
const catalogModels = computed<CatalogModel[]>(() => catalog.value?.models ?? [])
const catalogIds = computed(() => new Set(catalogModels.value.map((model) => model.id)))
const managedModels = computed<CatalogModel[]>(() => [
  ...catalogModels.value,
  ...draftModels.value
    .filter((model) => !catalogIds.value.has(model.id))
    .map((model) => ({ id: model.id, name: model.name || model.id })),
])
const newIds = computed(() => new Set(catalog.value?.newIds ?? []))
const enabledIds = computed(() => new Set(draftModels.value.map((m) => m.id)))
const draftChatModels = computed(() => draftModels.value.filter(isChatModelOption))
const replacementRequired = computed(
  () =>
    draftChatModels.value.length > 0 &&
    !draftChatModels.value.some((model) => model.id === draftSelectedModelId.value),
)

function comparableModel(model: ModelOption) {
  const canonical = canonicalizeModelOption(model)
  return {
    id: canonical.id,
    name: canonical.name,
    isCustom: Boolean(canonical.isCustom),
    capabilities: canonical.capabilities ?? [],
    embedding: canonical.embedding ?? null,
    toolReliability: canonical.toolReliability ?? null,
  }
}

const hasDraftChanges = computed(() => {
  return (
    JSON.stringify(props.provider.models.map(comparableModel)) !==
      JSON.stringify(draftModels.value.map(comparableModel)) ||
    (props.provider.selectedModelId || '') !== draftSelectedModelId.value
  )
})
const canApply = computed(() => hasDraftChanges.value && !replacementRequired.value)

/** 目录是否带元数据（决定能力筛选/徽章是否可用——宁可不标，不能标错） */
const hasMetadata = computed(() => catalogModels.value.some(catalogModelHasMetadata))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // 打开即视为已读"新增"，关闭入口蓝点；视图内仍可按"本次新增"筛选
    search.value = ''
    view.value = 'all'
    vendorFilter.value = '__all__'
    vendorSearch.value = ''
    capFilters.value = new Set()
    baselineModels.value = props.provider.models.map(cloneModelOption)
    baselineSelectedModelId.value = props.provider.selectedModelId || ''
    setDraftModels(props.provider.models)
    draftSelectedModelId.value = props.provider.selectedModelId || ''
    disarmClear()
    nextTick(() => searchInputRef.value?.focus())
  },
  { immediate: true },
)

watch(
  () => props.syncing,
  (syncing, wasSyncing) => {
    if (props.open && wasSyncing && !syncing) rebaseDraftAfterResync()
  },
)

function handleCancel() {
  catalogStore.markNewSeen(props.provider.id)
  disarmClear()
  emit('close')
}

// ─── 厂商分组（OpenRouter id 形如 vendor/model） ───────────
function vendorOf(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : t('settings.modelManager.otherVendor', '其他')
}

const vendorCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const m of managedModels.value) {
    const v = vendorOf(m.id)
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

const vendorEnabledCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const id of enabledIds.value) {
    const v = vendorOf(id)
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return counts
})

const visibleVendors = computed(() => {
  const q = vendorSearch.value.trim().toLowerCase()
  if (!q) return vendorCounts.value
  return vendorCounts.value.filter(([v]) => v.toLowerCase().includes(q))
})

/** 厂商侧栏只在分组有意义时显示（≥2 个厂商） */
const showVendorNav = computed(() => vendorCounts.value.length >= 2)

// ─── 筛选 ──────────────────────────────────────────────
const viewSegments = computed(() => [
  {
    key: 'all',
    label: `${t('settings.modelManager.viewAll', '全部')} ${managedModels.value.length}`,
  },
  {
    key: 'enabled',
    label: `${t('settings.modelManager.viewEnabled', '已启用')} ${enabledIds.value.size}`,
  },
  ...(newIds.value.size > 0
    ? [
        {
          key: 'new',
          label: `${t('settings.modelManager.viewNew', '本次新增')} ${newIds.value.size}`,
        },
      ]
    : []),
])

const capFilterOptions = computed(() => {
  const options = [
    { key: 'chat', label: t('settings.modelManager.filterChat', '文本对话') },
    { key: 'embedding', label: t('settings.modelManager.filterEmbedding', 'Embedding') },
  ]
  if (!hasMetadata.value) return options
  return [
    ...options,
    { key: 'free', label: t('settings.modelManager.filterFree', '免费') },
    { key: 'vision', label: t('settings.modelManager.filterVision', '视觉') },
    { key: 'tools', label: t('settings.modelManager.filterTools', '工具调用') },
    { key: 'ctx128', label: t('settings.modelManager.filterCtx', '≥128K 上下文') },
  ]
})

function toggleCapFilter(key: string) {
  const next = new Set(capFilters.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  capFilters.value = next
}

const filteredModels = computed(() => {
  const q = search.value.trim().toLowerCase()
  const f = capFilters.value
  return managedModels.value.filter((m) => {
    const capabilities = capabilitiesOf(m)
    if (view.value === 'enabled' && !enabledIds.value.has(m.id)) return false
    if (view.value === 'new' && !newIds.value.has(m.id)) return false
    if (vendorFilter.value !== '__all__' && vendorOf(m.id) !== vendorFilter.value) return false
    if (q && !m.id.toLowerCase().includes(q) && !(m.name ?? '').toLowerCase().includes(q))
      return false
    if (f.has('chat') && !capabilities.includes('text')) return false
    if (f.has('embedding') && !capabilities.includes('embedding')) return false
    if (f.has('free') && !isCatalogModelFree(m)) return false
    if (f.has('vision') && !capabilities.includes('vision')) return false
    if (f.has('tools') && !m.supportsTools) return false
    if (f.has('ctx128') && (m.contextLength ?? 0) < 128_000) return false
    return true
  })
})

const groupedModels = computed(() => {
  const groups = new Map<string, CatalogModel[]>()
  for (const m of filteredModels.value) {
    const v = vendorOf(m.id)
    const list = groups.get(v)
    if (list) list.push(m)
    else groups.set(v, [m])
  }
  return [...groups.entries()]
})

// ─── 推荐（聚合商首次接入引导） ─────────────────────────
const recommended = computed<CatalogModel[]>(() => {
  if (recDismissed.value || !hasMetadata.value) return []
  if (catalogModels.value.length <= AUTO_ENABLE_CATALOG_LIMIT) return []
  if (enabledIds.value.size >= 3) return []
  return catalogModels.value
    .filter((m) => isCatalogModelFree(m) && m.supportsTools && !enabledIds.value.has(m.id))
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
    .slice(0, 5)
})

const showRecommendBanner = computed(
  () =>
    recommended.value.length > 0 &&
    !search.value &&
    view.value === 'all' &&
    vendorFilter.value === '__all__' &&
    capFilters.value.size === 0,
)

function enableRecommended() {
  setDraftModels([...draftModels.value, ...recommended.value.map(toModelOption)])
}

// ─── 启用 / 停用 ────────────────────────────────────────
function cloneModelOption(model: ModelOption): ModelOption {
  return canonicalizeModelOption({
    ...model,
    ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
    ...(model.embedding ? { embedding: { ...model.embedding } } : {}),
    ...(model.toolReliability ? { toolReliability: { ...model.toolReliability } } : {}),
  })
}

function applyCatalogReasoningContract(
  model: ModelOption,
  catalogModel: CatalogModel,
): ModelOption {
  const hasReasoningSupport = Object.prototype.hasOwnProperty.call(catalogModel, 'reasoningSupport')
  const hasReasoningControl = Object.prototype.hasOwnProperty.call(catalogModel, 'reasoningControl')
  if (!hasReasoningSupport && !hasReasoningControl) return model

  const next = { ...model }
  delete next.reasoningSupport
  delete next.reasoningControl
  if (hasReasoningSupport) next.reasoningSupport = catalogModel.reasoningSupport
  if (hasReasoningControl) next.reasoningControl = catalogModel.reasoningControl
  return next
}

function modelOptionFromCatalog(m: CatalogModel, existing?: ModelOption): ModelOption {
  if (existing?.isCustom) return cloneModelOption(existing)
  if (existing) {
    return canonicalizeModelOption(
      applyCatalogReasoningContract(
        {
          ...cloneModelOption(existing),
          id: m.id,
          name: m.name || m.id,
        },
        m,
      ),
    )
  }
  return canonicalizeModelOption(
    applyCatalogReasoningContract(
      {
        id: m.id,
        name: m.name || m.id,
        capabilities: [],
      },
      m,
    ),
  )
}

function normalizeAgainstCatalog(model: ModelOption): ModelOption {
  if (model.isCustom) return cloneModelOption(model)
  const catalogModel = catalogModels.value.find((candidate) => candidate.id === model.id)
  return catalogModel ? modelOptionFromCatalog(catalogModel, model) : cloneModelOption(model)
}

function capabilitiesOf(m: CatalogModel): ModelCapability[] {
  const enabledModel = draftModels.value.find((model) => model.id === m.id)
  return modelOptionFromCatalog(m, enabledModel).capabilities ?? []
}

function isStaleCatalogModel(modelId: string): boolean {
  const enabledModel = draftModels.value.find((model) => model.id === modelId)
  if (!enabledModel || enabledModel.isCustom) return false
  const capabilities = enabledModel.capabilities ?? []
  if (capabilities.includes('image_generation') || capabilities.includes('video_generation')) {
    return false
  }
  return !catalogIds.value.has(modelId)
}

function toModelOption(m: CatalogModel): ModelOption {
  return modelOptionFromCatalog(
    m,
    draftModels.value.find((model) => model.id === m.id),
  )
}

function setDraftModels(models: ModelOption[]) {
  const seen = new Set<string>()
  draftModels.value = models.map(normalizeAgainstCatalog).filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function rebaseDraftAfterResync() {
  const baselineIds = new Set(baselineModels.value.map((model) => model.id))
  const draftIds = new Set(draftModels.value.map((model) => model.id))
  const explicitlyRemoved = new Set(
    baselineModels.value.filter((model) => !draftIds.has(model.id)).map((model) => model.id),
  )
  const userChangedSelection = draftSelectedModelId.value !== baselineSelectedModelId.value
  const preserveById = new Map<string, ModelOption>()
  for (const model of draftModels.value) {
    const isExplicitlyAdded = !baselineIds.has(model.id)
    const isNewCurrent = userChangedSelection && model.id === draftSelectedModelId.value
    const isRetainedStale = baselineIds.has(model.id) && !catalogIds.value.has(model.id)
    if (isExplicitlyAdded || isNewCurrent || isRetainedStale) {
      preserveById.set(model.id, model)
    }
  }
  const rebased = props.provider.models
    .filter((model) => !explicitlyRemoved.has(model.id))
    .map(normalizeAgainstCatalog)
  const rebasedIds = new Set(rebased.map((model) => model.id))
  for (const model of preserveById.values()) {
    if (rebasedIds.has(model.id)) continue
    rebased.push(normalizeAgainstCatalog(model))
    rebasedIds.add(model.id)
  }

  const preservedDraftSelection = draftSelectedModelId.value
  baselineModels.value = props.provider.models.map(cloneModelOption)
  baselineSelectedModelId.value = props.provider.selectedModelId || ''
  setDraftModels(rebased)
  draftSelectedModelId.value = userChangedSelection
    ? preservedDraftSelection
    : props.provider.selectedModelId || ''
}

function handleApply() {
  const models = draftModels.value.map(normalizeAgainstCatalog)
  const selectedModelId =
    draftChatModels.value.length === 0
      ? ''
      : resolveProviderSelectedModelId(
          { models, selectedModelId: draftSelectedModelId.value },
          draftSelectedModelId.value,
        )
  settingsStore.updateProvider(props.provider.id, {
    models,
    selectedModelId,
  })
  emit('change')
  catalogStore.markNewSeen(props.provider.id)
  disarmClear()
  emit('close')
}

function selectDraftCurrentModel(modelId: string) {
  const model = draftModels.value.find((candidate) => candidate.id === modelId)
  if (!model || !isChatModelOption(model)) return
  draftSelectedModelId.value = modelId
}

function toggleModel(m: CatalogModel) {
  if (enabledIds.value.has(m.id)) {
    setDraftModels(draftModels.value.filter((x) => x.id !== m.id))
  } else {
    setDraftModels([...draftModels.value, toModelOption(m)])
  }
}

function isGroupAllEnabled(models: CatalogModel[]): boolean {
  return models.every((m) => enabledIds.value.has(m.id))
}

function toggleGroup(models: CatalogModel[]) {
  if (isGroupAllEnabled(models)) {
    const ids = new Set(models.map((m) => m.id))
    setDraftModels(draftModels.value.filter((x) => !ids.has(x.id)))
  } else {
    const additions = models.filter((m) => !enabledIds.value.has(m.id)).map(toModelOption)
    setDraftModels([...draftModels.value, ...additions])
  }
}

// 清空启用：破坏性操作，两步确认，3 秒未确认自动解除
function handleClear() {
  if (!clearArmed.value) {
    clearArmed.value = true
    clearTimer = setTimeout(disarmClear, 3000)
    return
  }
  disarmClear()
  setDraftModels([])
}

function disarmClear() {
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = null
  clearArmed.value = false
}

// ─── 展示辅助 ──────────────────────────────────────────
function ctxLabel(ctx?: number): string {
  if (!ctx) return ''
  return ctx >= 1_000_000 ? `${Math.round(ctx / 1_000_000)}M` : `${Math.round(ctx / 1024)}K`
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    handleCancel()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    searchInputRef.value?.focus()
    return
  }
  if (e.key !== 'Tab') return

  const modal = modalRef.value
  if (!modal) return
  const focusable = Array.from(
    modal.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  )
  if (focusable.length === 0) {
    e.preventDefault()
    modal.focus()
    return
  }

  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && (active === first || !modal.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="hc-dialog">
      <div
        v-if="open"
        class="hc-dialog-overlay"
        tabindex="-1"
        @click.self="handleCancel"
        @keydown="handleKeydown"
      >
        <div
          ref="modalRef"
          class="mm-modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :aria-label="t('settings.modelManager.title', '管理模型')"
        >
          <!-- 头部 -->
          <div class="mm-head">
            <div class="mm-title-row">
              <span class="mm-title">
                {{ t('settings.modelManager.title', '管理模型') }} — {{ provider.name }}
              </span>
              <span v-if="newIds.size > 0" class="mm-badge mm-badge--new">
                {{
                  t(
                    'settings.modelManager.newCount',
                    { n: newIds.size },
                    `本次同步新增 ${newIds.size} 个`,
                  )
                }}
              </span>
              <span class="mm-spacer" />
              <span
                class="mm-sync-meta"
                data-testid="model-manager-last-sync"
                :data-synced-at="lastSuccessfulSyncAt || undefined"
              >
                {{
                  formattedLastSuccessfulSyncAt
                    ? t(
                        'settings.modelManager.lastSuccessfulSync',
                        { time: formattedLastSuccessfulSyncAt },
                        `上次成功同步：${formattedLastSuccessfulSyncAt}`,
                      )
                    : t('settings.modelManager.neverSynced', '尚未成功同步')
                }}
              </span>
              <button
                class="mm-icon-btn mm-resync"
                data-testid="model-manager-resync"
                :title="t('settings.modelManager.resync', '重新同步')"
                :aria-label="t('settings.modelManager.resync', '重新同步')"
                :disabled="syncing"
                @click="emit('resync')"
              >
                <RefreshCw :size="15" :class="{ 'animate-spin': syncing }" />
                <span>{{ t('settings.modelManager.resync', '重新同步') }}</span>
              </button>
              <button
                class="mm-icon-btn"
                :title="t('common.close', '关闭')"
                :aria-label="t('common.close', '关闭')"
                @click="handleCancel"
              >
                <X :size="15" />
              </button>
            </div>

            <div class="mm-search-row">
              <SearchInput
                ref="searchInputRef"
                v-model="search"
                fluid
                class="mm-search"
                :placeholder="t('settings.modelManager.searchPlaceholder', '搜索模型 id 或名称…')"
              />
              <span class="mm-kbd">⌘F</span>
            </div>

            <div class="mm-toolbar">
              <SegmentedControl v-model="view" :segments="viewSegments" />
              <template v-if="capFilterOptions.length">
                <span class="mm-toolbar__divider" />
                <span class="mm-toolbar__label">{{
                  t('settings.modelManager.filterLabel', '筛选')
                }}</span>
                <button
                  v-for="opt in capFilterOptions"
                  :key="opt.key"
                  class="mm-filter-chip"
                  :class="{ 'mm-filter-chip--on': capFilters.has(opt.key) }"
                  :data-testid="`model-manager-filter-${opt.key}`"
                  :aria-pressed="capFilters.has(opt.key)"
                  @click="toggleCapFilter(opt.key)"
                >
                  {{ opt.label }}
                </button>
              </template>
            </div>
          </div>

          <!-- 主体 -->
          <div class="mm-body">
            <!-- 厂商侧栏 -->
            <div v-if="showVendorNav" class="mm-vendors">
              <div class="mm-vendors__sticky">
                <SearchInput
                  v-if="vendorCounts.length > 10"
                  v-model="vendorSearch"
                  fluid
                  class="mm-vendors__search"
                  :placeholder="t('settings.modelManager.vendorSearch', '过滤厂商…')"
                />
                <button
                  class="mm-vendor"
                  :class="{ 'mm-vendor--active': vendorFilter === '__all__' }"
                  @click="vendorFilter = '__all__'"
                >
                  {{ t('settings.modelManager.allVendors', '全部') }}
                  <span v-if="enabledIds.size" class="mm-vendor__enabled">{{
                    enabledIds.size
                  }}</span>
                  <span class="mm-vendor__count">{{ managedModels.length }}</span>
                </button>
              </div>
              <button
                v-for="[vendor, count] in visibleVendors"
                :key="vendor"
                class="mm-vendor"
                :class="{ 'mm-vendor--active': vendorFilter === vendor }"
                @click="vendorFilter = vendor"
              >
                <span class="mm-vendor__name">{{ vendor }}</span>
                <span v-if="vendorEnabledCounts.get(vendor)" class="mm-vendor__enabled">
                  {{ vendorEnabledCounts.get(vendor) }}
                </span>
                <span class="mm-vendor__count">{{ count }}</span>
              </button>
            </div>

            <!-- 模型列表 -->
            <div class="mm-list">
              <!-- 推荐引导 -->
              <div v-if="showRecommendBanner" class="mm-recommend">
                <Sparkles :size="16" class="mm-recommend__icon" />
                <span class="mm-recommend__text">
                  {{
                    t(
                      'settings.modelManager.recommendText',
                      '根据「免费 + 支持工具调用 + 大上下文」为你推荐',
                    )
                  }}
                  <b>{{ recommended.map((m) => m.name).join('、') }}</b>
                </span>
                <button class="hc-btn hc-btn-primary hc-btn-sm" @click="enableRecommended">
                  {{ t('settings.modelManager.recommendEnable', '一键启用') }}
                </button>
                <button class="hc-btn hc-btn-sm" @click="recDismissed = true">
                  {{ t('settings.modelManager.recommendDismiss', '忽略') }}
                </button>
              </div>

              <div
                v-if="replacementRequired"
                id="model-manager-replacement-required"
                class="mm-replacement"
                data-testid="model-manager-replacement-required"
                role="alert"
                aria-live="polite"
              >
                {{
                  t(
                    'settings.modelManager.replacementRequired',
                    '请选择一个当前对话模型后再应用更改',
                  )
                }}
              </div>

              <div v-if="!filteredModels.length" class="mm-empty">
                {{ t('settings.modelManager.empty', '没有匹配的模型，试试调整搜索词或筛选条件') }}
              </div>

              <template v-for="[vendor, models] in groupedModels" :key="vendor">
                <div class="mm-group-head">
                  <span>{{ vendor }} · {{ models.length }}</span>
                  <span class="mm-group-head__line" />
                  <button class="mm-group-head__btn" @click="toggleGroup(models)">
                    {{
                      isGroupAllEnabled(models)
                        ? t('settings.modelManager.deselectGroup', '取消全选')
                        : t('settings.modelManager.selectGroup', '全选该组')
                    }}
                  </button>
                </div>
                <div
                  v-for="m in models"
                  :key="m.id"
                  class="mm-row"
                  :class="{ 'mm-row--on': enabledIds.has(m.id) }"
                >
                  <div class="mm-row__info">
                    <div class="mm-row__name">
                      {{ m.name }}
                      <span v-if="newIds.has(m.id)" class="mm-badge mm-badge--new">
                        {{ t('settings.modelManager.newTag', '新') }}
                      </span>
                      <span v-if="isStaleCatalogModel(m.id)" class="mm-badge mm-badge--stale">
                        {{ t('settings.llm.modelStaleLabel', '已下架') }}
                      </span>
                      <template v-if="hasMetadata">
                        <span v-if="isCatalogModelFree(m)" class="mm-badge mm-badge--free">
                          {{ t('settings.modelManager.badgeFree', '免费') }}
                        </span>
                        <span v-if="capabilitiesOf(m).includes('vision')" class="mm-badge">
                          {{ t('settings.modelManager.badgeVision', '视觉') }}
                        </span>
                        <span v-if="m.supportsTools" class="mm-badge">
                          {{ t('settings.modelManager.badgeTools', '工具') }}
                        </span>
                        <span v-if="capabilitiesOf(m).includes('embedding')" class="mm-badge">
                          {{ t('settings.modelManager.badgeEmbedding', 'Embedding') }}
                        </span>
                        <span v-if="m.contextLength" class="mm-badge">{{
                          ctxLabel(m.contextLength)
                        }}</span>
                      </template>
                    </div>
                    <div class="mm-row__id">{{ m.id }}</div>
                  </div>
                  <button
                    v-if="enabledIds.has(m.id) && capabilitiesOf(m).includes('text')"
                    type="button"
                    class="mm-current"
                    :class="{ 'mm-current--active': draftSelectedModelId === m.id }"
                    :data-testid="`model-manager-select-${m.id}`"
                    @click.stop="selectDraftCurrentModel(m.id)"
                  >
                    {{
                      draftSelectedModelId === m.id
                        ? t('settings.modelManager.currentModel', '当前')
                        : t('settings.modelManager.setCurrentModel', '设为当前')
                    }}
                  </button>
                  <button
                    type="button"
                    class="mm-row__toggle"
                    role="switch"
                    :aria-label="m.name"
                    :aria-checked="enabledIds.has(m.id)"
                    :data-testid="`model-manager-toggle-${m.id}`"
                    @click="toggleModel(m)"
                  >
                    <span class="mm-switch" aria-hidden="true" />
                  </button>
                </div>
              </template>
            </div>
          </div>

          <!-- 底部 -->
          <div class="mm-foot">
            <span class="mm-foot__summary">
              {{ t('settings.modelManager.enabledSummary', '已启用') }}
              <b>{{ enabledIds.size }}</b>
              {{ t('settings.modelManager.enabledUnit', '个模型') }}
            </span>
            <span class="mm-foot__hint">
              {{ t('settings.modelManager.leanHint', '建议保持精简：只启用常用的几个') }}
            </span>
            <span class="mm-spacer" />
            <button
              v-if="enabledIds.size > 0"
              class="mm-clear"
              :class="{ 'mm-clear--armed': clearArmed }"
              @click="handleClear"
            >
              {{
                clearArmed
                  ? t(
                      'settings.modelManager.clearConfirm',
                      { n: enabledIds.size },
                      `确认清空 ${enabledIds.size} 个？`,
                    )
                  : t('settings.modelManager.clear', '清空启用')
              }}
            </button>
            <button
              class="hc-btn hc-btn-secondary"
              data-testid="model-manager-cancel"
              @click="handleCancel"
            >
              {{ t('common.cancel', '取消') }}
            </button>
            <button
              class="hc-btn hc-btn-primary"
              data-testid="model-manager-apply"
              :disabled="!canApply"
              :aria-describedby="
                replacementRequired ? 'model-manager-replacement-required' : undefined
              "
              @click="handleApply"
            >
              {{ t('settings.modelManager.applyChanges', '应用更改') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-dialog-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.mm-modal {
  width: min(920px, 94vw);
  height: min(660px, 88vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  box-shadow: var(--hc-shadow-float);
}

.mm-spacer {
  flex: 1;
}

/* ── 头部 ── */
.mm-head {
  display: flex;
  flex-direction: column;
  gap: var(--hc-space-3);
  padding: var(--hc-space-5) var(--hc-space-5) var(--hc-space-3);
  border-bottom: 0.5px solid var(--hc-divider);
}
.mm-title-row {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
}
.mm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
}
.mm-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: none;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition:
    background-color 130ms ease,
    color 130ms ease;
}
.mm-icon-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.mm-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.mm-sync-meta {
  color: var(--hc-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

.mm-resync {
  width: auto;
  gap: 5px;
  padding: 0 9px;
}

.mm-search-row {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
}
.mm-search {
  flex: 1;
  min-width: 0;
}
.mm-kbd {
  padding: 1px 6px;
  border: 0.5px solid var(--hc-border);
  border-radius: 5px;
  font-size: 10px;
  color: var(--hc-text-muted);
}

.mm-toolbar {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  flex-wrap: wrap;
}
.mm-toolbar__divider {
  width: 0.5px;
  height: 16px;
  background: var(--hc-border);
  margin: 0 var(--hc-space-1);
}
.mm-toolbar__label {
  font-size: 11px;
  color: var(--hc-text-muted);
}
.mm-filter-chip {
  padding: 4px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 999px;
  background: none;
  font-size: 11.5px;
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition:
    border-color 130ms ease,
    background-color 130ms ease,
    color 130ms ease;
}
.mm-filter-chip--on {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 500;
}

/* ── 主体 ── */
.mm-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.mm-vendors {
  width: 172px;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--hc-space-2) var(--hc-space-3);
  border-right: 0.5px solid var(--hc-divider);
  background: var(--hc-bg-panel);
}
.mm-vendors__sticky {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: var(--hc-space-3) 0 var(--hc-space-2);
  background: var(--hc-bg-sidebar-solid);
  border-bottom: 0.5px solid var(--hc-divider);
  margin-bottom: var(--hc-space-1);
}
.mm-vendors__search {
  margin-bottom: var(--hc-space-2);
  width: 100%;
  height: 28px;
}
.mm-vendor {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--hc-radius-sm);
  background: none;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 130ms ease,
    color 130ms ease;
}
.mm-vendor:hover {
  background: var(--hc-bg-hover);
}
.mm-vendor--active {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 600;
}
.mm-vendor__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-vendor__enabled {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  font-size: 9.5px;
}
.mm-vendor__count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--hc-text-muted);
}
.mm-vendor--active .mm-vendor__count {
  color: var(--hc-accent);
}

.mm-list {
  flex: 1;
  overflow-y: auto;
  padding-bottom: var(--hc-space-4);
}

.mm-recommend {
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  margin: var(--hc-space-3) var(--hc-space-4) var(--hc-space-1);
  padding: var(--hc-space-3) var(--hc-space-4);
  border: 0.5px solid var(--hc-accent);
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle);
}
.mm-recommend__icon {
  color: var(--hc-accent);
  flex-shrink: 0;
}
.mm-recommend__text {
  flex: 1;
  font-size: 12.5px;
  color: var(--hc-text-primary);
}
.mm-recommend__text b {
  color: var(--hc-accent);
  font-weight: 600;
}

.mm-empty {
  padding: 64px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--hc-text-muted);
}

.mm-replacement {
  margin: var(--hc-space-3) var(--hc-space-4) var(--hc-space-1);
  padding: 8px 12px;
  border: 0.5px solid color-mix(in srgb, var(--hc-warning) 45%, var(--hc-border));
  border-radius: var(--hc-radius-sm);
  background: color-mix(in srgb, var(--hc-warning) 10%, transparent);
  color: var(--hc-text-primary);
  font-size: 12px;
}

.mm-group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  padding: 10px var(--hc-space-5) 6px;
  background: var(--hc-bg-elevated);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--hc-text-secondary);
  text-transform: uppercase;
}
.mm-group-head__line {
  flex: 1;
  height: 0.5px;
  background: var(--hc-divider);
}
.mm-group-head__btn {
  border: none;
  background: none;
  font-size: 11px;
  font-weight: 500;
  color: var(--hc-accent);
  cursor: pointer;
  text-transform: none;
}
.mm-group-head__btn:hover {
  text-decoration: underline;
}

.mm-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  padding: 9px calc(var(--hc-space-5) + 36px + var(--hc-space-3)) 9px var(--hc-space-5);
  cursor: pointer;
  outline: none;
  transition: background-color 130ms ease;
}
.mm-row:hover {
  background: var(--hc-bg-hover);
}
.mm-row:focus-within {
  background: var(--hc-accent-subtle);
  box-shadow: inset 3px 0 0 var(--hc-accent);
}
.mm-row__info {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  pointer-events: none;
}
.mm-row__name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
}
.mm-row__id {
  font-size: 11px;
  font-family: ui-monospace, 'SF Mono', monospace;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-current {
  position: relative;
  z-index: 2;
  flex: none;
  border: none;
  border-radius: var(--hc-radius-sm);
  padding: 4px 8px;
  background: transparent;
  color: var(--hc-text-muted);
  font-size: 11px;
  cursor: pointer;
}
.mm-current:hover {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.mm-current--active {
  color: var(--hc-accent);
  font-weight: 600;
}

.mm-row__toggle {
  position: absolute;
  z-index: 0;
  inset: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.mm-row__toggle:focus-visible {
  outline: none;
}
.mm-row__toggle .mm-switch {
  position: absolute;
  right: var(--hc-space-5);
  top: 50%;
  transform: translateY(-50%);
}

.mm-badge {
  padding: 1.5px 7px;
  border-radius: 5px;
  background: var(--hc-bg-active);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  white-space: nowrap;
}
.mm-badge--free {
  background: rgba(50, 213, 131, 0.14);
  color: var(--hc-success);
}
.mm-badge--new {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.mm-badge--stale {
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
  color: var(--hc-warning);
}

.mm-switch {
  position: relative;
  z-index: 1;
  width: 36px;
  height: 21px;
  flex-shrink: 0;
  border-radius: 999px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-active);
  transition:
    background-color 200ms ease,
    border-color 200ms ease;
}
.mm-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--hc-shadow-sm);
  transition: left 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.mm-row--on .mm-switch {
  background: var(--hc-accent);
  border-color: var(--hc-accent);
}
.mm-row--on .mm-switch::after {
  left: 17px;
}

/* ── 底部 ── */
.mm-foot {
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  padding: var(--hc-space-3) var(--hc-space-5);
  border-top: 0.5px solid var(--hc-divider);
  background: var(--hc-bg-panel);
}
.mm-foot__summary {
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.mm-foot__summary b {
  font-size: 14px;
  color: var(--hc-accent);
}
.mm-foot__hint {
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.mm-clear {
  border: none;
  border-radius: var(--hc-radius-sm);
  background: none;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--hc-text-muted);
  cursor: pointer;
  transition:
    background-color 130ms ease,
    color 130ms ease;
}
.mm-clear:hover {
  background: rgba(245, 101, 101, 0.12);
  color: var(--hc-error);
}
.mm-clear--armed {
  background: var(--hc-error);
  color: var(--hc-text-inverse);
  font-weight: 600;
}

/* 入场动效（沿用 hc-dialog Transition 命名） */
.hc-dialog-enter-active {
  transition: opacity 300ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hc-dialog-leave-active {
  transition: opacity 200ms ease;
}
.hc-dialog-enter-active .mm-modal {
  animation: mm-scale-in 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hc-dialog-enter-from,
.hc-dialog-leave-to {
  opacity: 0;
}
@keyframes mm-scale-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
