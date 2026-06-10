<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search, X, RefreshCw, Sparkles } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useModelCatalogStore } from '@/stores/model-catalog'
import { inferCapabilitiesFromId } from '@/config/providers'
import { isCatalogModelFree, catalogModelHasMetadata } from '@/types'
import type { CatalogModel, ModelCapability, ModelOption, ProviderConfig } from '@/types'
import SegmentedControl from '@/components/common/SegmentedControl.vue'

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

const { t } = useI18n()
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
const searchInputRef = ref<HTMLInputElement | null>(null)

const catalog = computed(() => catalogStore.getCatalog(props.provider.id))
const catalogModels = computed<CatalogModel[]>(() => catalog.value?.models ?? [])
const newIds = computed(() => new Set(catalog.value?.newIds ?? []))
const enabledIds = computed(() => new Set(props.provider.models.map((m) => m.id)))

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
    disarmClear()
    nextTick(() => searchInputRef.value?.focus())
  },
)

function handleClose() {
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
  for (const m of catalogModels.value) {
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
  { key: 'all', label: `${t('settings.modelManager.viewAll', '全部')} ${catalogModels.value.length}` },
  { key: 'enabled', label: `${t('settings.modelManager.viewEnabled', '已启用')} ${enabledIds.value.size}` },
  ...(newIds.value.size > 0
    ? [{ key: 'new', label: `${t('settings.modelManager.viewNew', '本次新增')} ${newIds.value.size}` }]
    : []),
])

const capFilterOptions = computed(() => {
  if (!hasMetadata.value) return []
  return [
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
  return catalogModels.value.filter((m) => {
    if (view.value === 'enabled' && !enabledIds.value.has(m.id)) return false
    if (view.value === 'new' && !newIds.value.has(m.id)) return false
    if (vendorFilter.value !== '__all__' && vendorOf(m.id) !== vendorFilter.value) return false
    if (q && !m.id.toLowerCase().includes(q) && !(m.name ?? '').toLowerCase().includes(q)) return false
    if (f.has('free') && !isCatalogModelFree(m)) return false
    if (f.has('vision') && !m.inputModalities?.includes('image')) return false
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
const RECOMMEND_MIN_CATALOG = 20
const recommended = computed<CatalogModel[]>(() => {
  if (recDismissed.value || !hasMetadata.value) return []
  if (catalogModels.value.length <= RECOMMEND_MIN_CATALOG) return []
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
  setModels([...props.provider.models, ...recommended.value.map(toModelOption)])
}

// ─── 启用 / 停用 ────────────────────────────────────────
function capabilitiesOf(m: CatalogModel): ModelCapability[] {
  const caps = inferCapabilitiesFromId(m.id)
  if (m.inputModalities?.includes('image') && caps.includes('text') && !caps.includes('vision')) {
    caps.push('vision')
  }
  return caps
}

function toModelOption(m: CatalogModel): ModelOption {
  return { id: m.id, name: m.name || m.id, capabilities: capabilitiesOf(m) }
}

function setModels(models: ModelOption[]) {
  const selectedStillValid = models.some((m) => m.id === props.provider.selectedModelId)
  settingsStore.updateProvider(props.provider.id, {
    models,
    selectedModelId: selectedStillValid ? props.provider.selectedModelId : models[0]?.id || '',
  })
  emit('change')
}

function toggleModel(m: CatalogModel) {
  if (enabledIds.value.has(m.id)) {
    setModels(props.provider.models.filter((x) => x.id !== m.id))
  } else {
    setModels([...props.provider.models, toModelOption(m)])
  }
}

function isGroupAllEnabled(models: CatalogModel[]): boolean {
  return models.every((m) => enabledIds.value.has(m.id))
}

function toggleGroup(models: CatalogModel[]) {
  if (isGroupAllEnabled(models)) {
    const ids = new Set(models.map((m) => m.id))
    setModels(props.provider.models.filter((x) => !ids.has(x.id)))
  } else {
    const additions = models.filter((m) => !enabledIds.value.has(m.id)).map(toModelOption)
    setModels([...props.provider.models, ...additions])
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
  setModels([])
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
    handleClose()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    searchInputRef.value?.focus()
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
        @click.self="handleClose"
        @keydown="handleKeydown"
      >
        <div class="mm-modal" role="dialog" :aria-label="t('settings.modelManager.title', '管理模型')">
          <!-- 头部 -->
          <div class="mm-head">
            <div class="mm-title-row">
              <span class="mm-title">
                {{ t('settings.modelManager.title', '管理模型') }} — {{ provider.name }}
              </span>
              <span v-if="newIds.size > 0" class="mm-badge mm-badge--new">
                {{ t('settings.modelManager.newCount', { n: newIds.size }, `本次同步新增 ${newIds.size} 个`) }}
              </span>
              <span class="mm-spacer" />
              <button
                class="mm-icon-btn"
                :title="t('settings.modelManager.resync', '重新同步')"
                :disabled="syncing"
                @click="emit('resync')"
              >
                <RefreshCw :size="15" :class="{ 'animate-spin': syncing }" />
              </button>
              <button class="mm-icon-btn" :title="t('common.close', '关闭')" @click="handleClose">
                <X :size="15" />
              </button>
            </div>

            <div class="mm-search">
              <Search :size="14" class="mm-search__icon" />
              <input
                ref="searchInputRef"
                v-model="search"
                type="text"
                :placeholder="t('settings.modelManager.searchPlaceholder', '搜索模型 id 或名称…')"
              />
              <span class="mm-kbd">⌘F</span>
            </div>

            <div class="mm-toolbar">
              <SegmentedControl v-model="view" :segments="viewSegments" />
              <template v-if="capFilterOptions.length">
                <span class="mm-toolbar__divider" />
                <span class="mm-toolbar__label">{{ t('settings.modelManager.filterLabel', '筛选') }}</span>
                <button
                  v-for="opt in capFilterOptions"
                  :key="opt.key"
                  class="mm-filter-chip"
                  :class="{ 'mm-filter-chip--on': capFilters.has(opt.key) }"
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
                <div v-if="vendorCounts.length > 10" class="mm-vendors__search">
                  <Search :size="11" />
                  <input
                    v-model="vendorSearch"
                    type="text"
                    :placeholder="t('settings.modelManager.vendorSearch', '过滤厂商…')"
                  />
                </div>
                <button
                  class="mm-vendor"
                  :class="{ 'mm-vendor--active': vendorFilter === '__all__' }"
                  @click="vendorFilter = '__all__'"
                >
                  {{ t('settings.modelManager.allVendors', '全部') }}
                  <span v-if="enabledIds.size" class="mm-vendor__enabled">{{ enabledIds.size }}</span>
                  <span class="mm-vendor__count">{{ catalogModels.length }}</span>
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
                  {{ t('settings.modelManager.recommendText', '根据「免费 + 支持工具调用 + 大上下文」为你推荐') }}
                  <b>{{ recommended.map((m) => m.name).join('、') }}</b>
                </span>
                <button class="hc-btn hc-btn-primary hc-btn-sm" @click="enableRecommended">
                  {{ t('settings.modelManager.recommendEnable', '一键启用') }}
                </button>
                <button class="hc-btn hc-btn-sm" @click="recDismissed = true">
                  {{ t('settings.modelManager.recommendDismiss', '忽略') }}
                </button>
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
                  role="switch"
                  :aria-checked="enabledIds.has(m.id)"
                  tabindex="0"
                  @click="toggleModel(m)"
                  @keydown.enter.prevent="toggleModel(m)"
                  @keydown.space.prevent="toggleModel(m)"
                >
                  <div class="mm-row__info">
                    <div class="mm-row__name">
                      {{ m.name }}
                      <span v-if="newIds.has(m.id)" class="mm-badge mm-badge--new">
                        {{ t('settings.modelManager.newTag', '新') }}
                      </span>
                      <template v-if="hasMetadata">
                        <span v-if="isCatalogModelFree(m)" class="mm-badge mm-badge--free">
                          {{ t('settings.modelManager.badgeFree', '免费') }}
                        </span>
                        <span v-if="m.inputModalities?.includes('image')" class="mm-badge">
                          {{ t('settings.modelManager.badgeVision', '视觉') }}
                        </span>
                        <span v-if="m.supportsTools" class="mm-badge">
                          {{ t('settings.modelManager.badgeTools', '工具') }}
                        </span>
                        <span v-if="m.contextLength" class="mm-badge">{{ ctxLabel(m.contextLength) }}</span>
                      </template>
                    </div>
                    <div class="mm-row__id">{{ m.id }}</div>
                  </div>
                  <span class="mm-switch" />
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
                  ? t('settings.modelManager.clearConfirm', { n: enabledIds.size }, `确认清空 ${enabledIds.size} 个？`)
                  : t('settings.modelManager.clear', '清空启用')
              }}
            </button>
            <button class="hc-btn hc-btn-primary" @click="handleClose">
              {{ t('common.done', '完成') }}
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

.mm-spacer { flex: 1; }

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
  transition: background-color 130ms ease, color 130ms ease;
}
.mm-icon-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.mm-icon-btn:disabled { opacity: 0.5; cursor: default; }

.mm-search {
  display: flex;
  align-items: center;
  gap: var(--hc-space-2);
  padding: 8px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.mm-search:focus-within {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.mm-search__icon { color: var(--hc-text-muted); }
.mm-search input {
  flex: 1;
  border: none;
  outline: none;
  background: none;
  font-size: 13px;
  color: var(--hc-text-primary);
}
.mm-search input::placeholder { color: var(--hc-text-muted); }
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
  transition: border-color 130ms ease, background-color 130ms ease, color 130ms ease;
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
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-bottom: var(--hc-space-2);
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-input);
  color: var(--hc-text-muted);
}
.mm-vendors__search input {
  width: 100%;
  border: none;
  outline: none;
  background: none;
  font-size: 11px;
  color: var(--hc-text-primary);
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
  transition: background-color 130ms ease, color 130ms ease;
}
.mm-vendor:hover { background: var(--hc-bg-hover); }
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
.mm-vendor--active .mm-vendor__count { color: var(--hc-accent); }

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
.mm-recommend__icon { color: var(--hc-accent); flex-shrink: 0; }
.mm-recommend__text {
  flex: 1;
  font-size: 12.5px;
  color: var(--hc-text-primary);
}
.mm-recommend__text b { color: var(--hc-accent); font-weight: 600; }

.mm-empty {
  padding: 64px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--hc-text-muted);
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
.mm-group-head__btn:hover { text-decoration: underline; }

.mm-row {
  display: flex;
  align-items: center;
  gap: var(--hc-space-3);
  padding: 9px var(--hc-space-5);
  cursor: pointer;
  outline: none;
  transition: background-color 130ms ease;
}
.mm-row:hover { background: var(--hc-bg-hover); }
.mm-row:focus-visible {
  background: var(--hc-accent-subtle);
  box-shadow: inset 3px 0 0 var(--hc-accent);
}
.mm-row__info { flex: 1; min-width: 0; }
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

.mm-switch {
  position: relative;
  width: 36px;
  height: 21px;
  flex-shrink: 0;
  border-radius: 999px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-active);
  transition: background-color 200ms ease, border-color 200ms ease;
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
.mm-row--on .mm-switch::after { left: 17px; }

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
  transition: background-color 130ms ease, color 130ms ease;
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
.hc-dialog-enter-active { transition: opacity 300ms cubic-bezier(0.16, 1, 0.3, 1); }
.hc-dialog-leave-active { transition: opacity 200ms ease; }
.hc-dialog-enter-active .mm-modal {
  animation: mm-scale-in 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.hc-dialog-enter-from,
.hc-dialog-leave-to { opacity: 0; }
@keyframes mm-scale-in {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
