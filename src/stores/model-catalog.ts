import { ref } from 'vue'
import { defineStore } from 'pinia'
import { logger } from '@/utils/logger'
import {
  canonicalizeModelOption,
  resolveProviderSelectedModelId,
} from '@/config/model-contract'
import { inferCapabilitiesFromId } from '@/config/providers'
import type { CatalogModel, ModelOption, ProviderConfig } from '@/types'

/**
 * 模型目录 store — "目录 / 启用"两层架构的目录层。
 *
 * 目录 = 从 Provider /models 同步到的全量可用模型（OpenRouter 可达数百个），
 * 只存本地缓存（localStorage），不进配置文件；
 * 启用 = 用户策展的子集（provider.models），才进配置持久化。
 *
 * 与 settings store 的 ollamaModelsCache 同理：动态可再生数据不污染配置链。
 */

const STORAGE_KEY = 'hexclaw.model-catalog.v1'

/**
 * 小目录（官方直连服务商，如智谱 8 个模型）阈值：
 * ≤ 此值时维持简单形态——同步直接全量进启用列表（provider.models），卡片平铺展示；
 * > 此值视为聚合中转站（OpenRouter 数百模型），只进目录，由模型管理器按需启用。
 */
export const AUTO_ENABLE_CATALOG_LIMIT = 10

export interface ProviderCatalog {
  models: CatalogModel[]
  /** ISO 8601 同步时间 */
  syncedAt: string
  /** 本次同步相对上次新增的模型 id（用于"新增"视图和入口蓝点） */
  newIds: string[]
}

type CatalogMap = Record<string, ProviderCatalog>

function loadFromStorage(): CatalogMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CatalogMap
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (e) {
    logger.warn('[ModelCatalog] 读取本地缓存失败，按空目录处理:', e)
    return {}
  }
}

export const useModelCatalogStore = defineStore('modelCatalog', () => {
  const catalogs = ref<CatalogMap>(loadFromStorage())

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogs.value))
    } catch (e) {
      // 配额满等场景只降级为"每次重新同步"，不影响功能
      logger.warn('[ModelCatalog] 写入本地缓存失败:', e)
    }
  }

  /** 同步一份新目录，自动 diff 出相对上次的新增模型 */
  function setCatalog(providerId: string, models: CatalogModel[]) {
    const prev = catalogs.value[providerId]
    // 首次同步不标"新增"（全是新的等于没有新的）
    const newIds = prev
      ? models.filter((m) => !prev.models.some((p) => p.id === m.id)).map((m) => m.id)
      : []
    catalogs.value[providerId] = {
      models,
      syncedAt: new Date().toISOString(),
      newIds,
    }
    persist()
  }

  function getCatalog(providerId: string): ProviderCatalog | null {
    return catalogs.value[providerId] ?? null
  }

  /** 清除某 Provider 的目录（Provider 被删除时调用） */
  function removeCatalog(providerId: string) {
    if (!(providerId in catalogs.value)) return
    delete catalogs.value[providerId]
    persist()
  }

  /** 已读"新增"标记（用户打开管理器后清除入口蓝点） */
  function markNewSeen(providerId: string) {
    const entry = catalogs.value[providerId]
    if (!entry || entry.newIds.length === 0) return
    entry.newIds = []
    persist()
  }

  return { catalogs, setCatalog, getCatalog, removeCatalog, markNewSeen }
})

/**
 * 识别并清理"全量灌入"污染的启用列表。
 *
 * 灌入特征：启用列表超过阈值，且其中来自目录的非自定义模型覆盖了目录的绝大部分
 * （≥90%）——没有用户会手动启用整个目录，这只可能是旧版同步逻辑灌进去的。
 * 清理后保留：自定义模型、图像/视频/向量模型、当前选中模型，以及目录已下架的既有模型。
 *
 * 返回 null 表示不是灌入污染（如用户手动启用了几十个），不做任何修改。
 */
export function trimFloodedModels(
  models: ModelOption[],
  catalog: CatalogModel[],
  selectedModelId: string | undefined,
): ModelOption[] | null {
  if (models.length <= AUTO_ENABLE_CATALOG_LIMIT) return null
  // 只对聚合商规模的目录做灌入识别：中等目录（如 15 个模型的官方直连商）
  // 用户通过"全选该组"主动启用全部是合法操作，不能命中灌入特征被误杀
  if (catalog.length < AUTO_ENABLE_CATALOG_LIMIT * 5) return null

  const catalogIds = new Set(catalog.map((m) => m.id))
  const isKeep = (m: ModelOption) =>
    m.isCustom ||
    m.id === selectedModelId ||
    !catalogIds.has(m.id) ||
    !!m.capabilities?.some(
      (c) => c === 'image_generation' || c === 'video_generation' || c === 'embedding',
    )

  const fromCatalog = models.filter((m) => !isKeep(m) && catalogIds.has(m.id))
  if (fromCatalog.length < catalog.length * 0.9) return null

  return models.filter(isKeep)
}

export interface ProviderCatalogReconcileResult {
  changed: boolean
  managed: boolean
}

function modelListSignature(models: ModelOption[], selectedModelId: string | undefined): string {
  return JSON.stringify({ models, selectedModelId: selectedModelId ?? '' })
}

/**
 * 将远端目录投影到 Provider 的“已启用模型”层。
 *
 * - 小目录：目录内模型全部启用；既有但本次未返回的条目继续保留，由目录层投影为 stale。
 * - 大目录：不自动启用新条目；只刷新已启用项名称，并收缩可识别的历史全量灌入。
 */
export function reconcileProviderCatalog(
  target: ProviderConfig,
  remoteModels: CatalogModel[],
  presetDefaults: ModelOption[],
): ProviderCatalogReconcileResult {
  const before = modelListSignature(target.models, target.selectedModelId)
  const managed = remoteModels.length > AUTO_ENABLE_CATALOG_LIMIT
  const remoteById = new Map(remoteModels.map((model) => [model.id, model]))

  if (managed) {
    const trimmed = trimFloodedModels(target.models, remoteModels, target.selectedModelId)
    if (trimmed) target.models = trimmed
    target.models = target.models.map((model) => {
      const remote = remoteById.get(model.id)
      if (!remote?.name || remote.name === model.name || model.isCustom) return model
      return canonicalizeModelOption({ ...model, name: remote.name })
    })
  } else {
    const existingById = new Map(target.models.map((model) => [model.id, model]))
    const presetById = new Map(presetDefaults.map((model) => [model.id, model]))
    const next: ModelOption[] = remoteModels.map((remote) => {
      const existing = existingById.get(remote.id)
      const preset = presetById.get(remote.id)
      if (existing) {
        return canonicalizeModelOption({
          ...existing,
          name: remote.name || existing.name || remote.id,
        })
      }
      return canonicalizeModelOption({
        id: remote.id,
        name: remote.name || remote.id,
        capabilities: preset?.capabilities ?? inferCapabilitiesFromId(remote.id),
        ...(preset?.embedding ? { embedding: { ...preset.embedding } } : {}),
      })
    })
    for (const existing of target.models) {
      if (!remoteById.has(existing.id)) next.push(canonicalizeModelOption(existing))
    }
    target.models = next
  }

  target.selectedModelId = resolveProviderSelectedModelId(target)
  return {
    changed: before !== modelListSignature(target.models, target.selectedModelId),
    managed,
  }
}

interface ProviderCatalogSyncLease {
  isCurrent(provider: ProviderConfig, effectiveBaseUrl: string): boolean
}

const providerCatalogSyncGenerations = new Map<string, number>()

function providerCatalogSyncFingerprint(
  provider: ProviderConfig,
  effectiveBaseUrl: string,
): string {
  return JSON.stringify([
    provider.providerInstanceId ?? '',
    provider.backendKey ?? '',
    effectiveBaseUrl.trim().replace(/\/+$/, ''),
    provider.locality ?? 'auto',
    provider.privateNetworkAccess?.host ?? '',
    provider.privateNetworkAccess?.allowed ?? false,
  ])
}

/** 为一次目录同步签发单写 generation；旧请求完成后只能被丢弃。 */
export function beginProviderCatalogSync(
  provider: ProviderConfig,
  effectiveBaseUrl: string,
): ProviderCatalogSyncLease {
  const providerId = provider.id
  const generation = (providerCatalogSyncGenerations.get(providerId) ?? 0) + 1
  const fingerprint = providerCatalogSyncFingerprint(provider, effectiveBaseUrl)
  providerCatalogSyncGenerations.set(providerId, generation)
  return {
    isCurrent(currentProvider, currentBaseUrl) {
      return (
        currentProvider.id === providerId &&
        providerCatalogSyncGenerations.get(providerId) === generation &&
        providerCatalogSyncFingerprint(currentProvider, currentBaseUrl) === fingerprint
      )
    },
  }
}
