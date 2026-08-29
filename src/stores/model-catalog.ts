import { ref } from 'vue'
import { defineStore } from 'pinia'
import { logger } from '@/utils/logger'
import { canonicalizeModelOption, resolveProviderSelectedModelId } from '@/config/model-contract'
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
const EXCLUSIONS_STORAGE_KEY = 'hexclaw.model-catalog-exclusions.v1'

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
  /** remote = Provider 目录；fallback = 远端不可用时由已持久化启用项形成的快照。 */
  source?: 'remote' | 'fallback'
}

type CatalogMap = Record<string, ProviderCatalog>
type ExclusionMap = Record<string, string[]>
type ReasoningContract = Pick<ModelOption, 'reasoningSupport' | 'reasoningControl'>

function hasReasoningDeclaration(
  source: ReasoningContract | undefined,
): source is ReasoningContract {
  return source?.reasoningSupport !== undefined || source?.reasoningControl !== undefined
}

function reasoningContractFrom(
  ...sources: Array<ReasoningContract | undefined>
): Partial<ReasoningContract> {
  const source = sources.find(hasReasoningDeclaration)
  if (!source) return {}
  return {
    ...(source.reasoningSupport === undefined ? {} : { reasoningSupport: source.reasoningSupport }),
    ...(source.reasoningControl === undefined ? {} : { reasoningControl: source.reasoningControl }),
  }
}

function withoutReasoningContract(model: ModelOption): ModelOption {
  const copy = { ...model }
  delete copy.reasoningSupport
  delete copy.reasoningControl
  return copy
}

function normalizeExcludedModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

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

function loadExclusionsFromStorage(): ExclusionMap {
  try {
    const raw = localStorage.getItem(EXCLUSIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ExclusionMap
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).map(([providerInstanceId, modelIds]) => [
        providerInstanceId,
        Array.isArray(modelIds)
          ? [...new Set(modelIds.map(normalizeExcludedModelId).filter(Boolean))]
          : [],
      ]),
    )
  } catch (e) {
    logger.warn('[ModelCatalog] 读取模型排除集合失败，按空集合处理:', e)
    return {}
  }
}

export const useModelCatalogStore = defineStore('modelCatalog', () => {
  const catalogs = ref<CatalogMap>(loadFromStorage())
  const exclusions = ref<ExclusionMap>(loadExclusionsFromStorage())

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogs.value))
    } catch (e) {
      // 配额满等场景只降级为"每次重新同步"，不影响功能
      logger.warn('[ModelCatalog] 写入本地缓存失败:', e)
    }
  }

  function persistExclusions(): boolean {
    try {
      localStorage.setItem(EXCLUSIONS_STORAGE_KEY, JSON.stringify(exclusions.value))
      return true
    } catch (e) {
      logger.warn('[ModelCatalog] 写入模型排除集合失败:', e)
      return false
    }
  }

  function excludeModel(providerInstanceId: string, modelId: string): boolean {
    const normalizedId = normalizeExcludedModelId(modelId)
    if (!providerInstanceId || !normalizedId) return false
    const previous = exclusions.value[providerInstanceId] ?? []
    if (!previous.includes(normalizedId)) {
      exclusions.value[providerInstanceId] = [...previous, normalizedId]
    }
    return persistExclusions()
  }

  function clearModelExclusion(providerInstanceId: string, modelId: string): boolean {
    const normalizedId = normalizeExcludedModelId(modelId)
    if (!providerInstanceId || !normalizedId) return false
    const previous = exclusions.value[providerInstanceId] ?? []
    const next = previous.filter((candidate) => candidate !== normalizedId)
    if (next.length > 0) exclusions.value[providerInstanceId] = next
    else delete exclusions.value[providerInstanceId]
    return persistExclusions()
  }

  function getExcludedModelIds(providerInstanceId: string): ReadonlySet<string> {
    return new Set(exclusions.value[providerInstanceId] ?? [])
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
      source: 'remote',
    }
    persist()
  }

  /**
   * 远端目录尚不可用时，以已持久化启用项建立稳定快照。
   * 仅大于自动启用阈值且没有可用目录时建立；后续 setCatalog 会整份替换为远端目录。
   */
  function ensureFallbackCatalog(providerId: string, models: ModelOption[]) {
    if (models.length <= AUTO_ENABLE_CATALOG_LIMIT) return
    if ((catalogs.value[providerId]?.models.length ?? 0) > 0) return
    catalogs.value[providerId] = {
      models: models.map((model) => {
        const canonical = canonicalizeModelOption(model)
        return {
          id: canonical.id,
          name: canonical.name || canonical.id,
          ...reasoningContractFrom(canonical),
        }
      }),
      syncedAt: new Date().toISOString(),
      newIds: [],
      source: 'fallback',
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

  return {
    catalogs,
    exclusions,
    setCatalog,
    ensureFallbackCatalog,
    getCatalog,
    removeCatalog,
    markNewSeen,
    excludeModel,
    clearModelExclusion,
    getExcludedModelIds,
  }
})

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
 * - 大目录：不自动启用或删除任何条目；只刷新已启用项名称。
 */
export function reconcileProviderCatalog(
  target: ProviderConfig,
  remoteModels: CatalogModel[],
  presetDefaults: ModelOption[],
  excludedModelIds: ReadonlySet<string> = new Set(),
): ProviderCatalogReconcileResult {
  const before = modelListSignature(target.models, target.selectedModelId)
  const isCuratedSubset =
    target.models.length > 0 &&
    target.models.length < remoteModels.length &&
    target.models.every((model) => {
      const normalized = normalizeExcludedModelId(model.id)
      return !excludedModelIds.has(normalized) && remoteModels.some((remote) => normalizeExcludedModelId(remote.id) === normalized)
    })
  const managed = remoteModels.length > AUTO_ENABLE_CATALOG_LIMIT || isCuratedSubset
  const remoteById = new Map(remoteModels.map((model) => [model.id, model]))
  const presetById = new Map(presetDefaults.map((model) => [model.id, model]))
  const normalizedExclusions = new Set(
    [...excludedModelIds].map(normalizeExcludedModelId).filter(Boolean),
  )
  const isExcluded = (modelId: string) =>
    normalizedExclusions.has(normalizeExcludedModelId(modelId))

  if (managed) {
    target.models = target.models
      .filter((model) => !isExcluded(model.id))
      .map((model) => {
        const remote = remoteById.get(model.id)
        if (!remote || model.isCustom) return model
        return canonicalizeModelOption({
          ...withoutReasoningContract(model),
          name: remote.name || model.name || remote.id,
          ...reasoningContractFrom(remote, model, presetById.get(model.id)),
        })
      })
  } else {
    const existingById = new Map(target.models.map((model) => [model.id, model]))
    const next: ModelOption[] = remoteModels
      .filter((remote) => !isExcluded(remote.id))
      .map((remote) => {
        const existing = existingById.get(remote.id)
        const preset = presetById.get(remote.id)
        if (existing) {
          return canonicalizeModelOption({
            ...withoutReasoningContract(existing),
            name: remote.name || existing.name || remote.id,
            ...reasoningContractFrom(remote, existing, preset),
          })
        }
        return canonicalizeModelOption({
          id: remote.id,
          name: remote.name || remote.id,
          // 带输入模态但没有能力合同的目录项保持显式空数组，不能由模型名或目录元数据推断。
          // 完全裸的 legacy 目录项保留能力缺失语义，沿用既有文本兼容默认。
          // 只有命中静态 preset 才写入明确能力，避免把未知目录模型误判为 embedding-only。
          ...(preset
            ? {
                capabilities: [...(preset.capabilities ?? [])],
                ...(preset.embedding ? { embedding: { ...preset.embedding } } : {}),
              }
            : remote.inputModalities === undefined
              ? {}
              : { capabilities: [] }),
          ...reasoningContractFrom(remote, preset),
        })
      })
    for (const existing of target.models) {
      if (!remoteById.has(existing.id) && !isExcluded(existing.id)) {
        next.push(canonicalizeModelOption(existing))
      }
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
const credentialSummarySalt = (() => {
  const bytes = new Uint32Array(2)
  globalThis.crypto?.getRandomValues?.(bytes)
  if (bytes[0] || bytes[1]) return `${bytes[0]!.toString(16)}${bytes[1]!.toString(16)}`
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
})()

/**
 * 仅用于当前进程内的 lease 等值判断。随机盐摘要不会持久化、输出日志或暴露 API Key 明文。
 */
function credentialSummary(apiKey: string | undefined): string {
  const input = `${credentialSummarySalt}\0${apiKey ?? ''}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

/** 单调废止该 Provider 已签发的全部目录同步 lease。 */
export function invalidateProviderCatalogSync(providerId: string): void {
  providerCatalogSyncGenerations.set(
    providerId,
    (providerCatalogSyncGenerations.get(providerId) ?? 0) + 1,
  )
}

function providerCatalogSyncFingerprint(
  provider: ProviderConfig,
  effectiveBaseUrl: string,
): string {
  return JSON.stringify([
    provider.providerInstanceId ?? '',
    provider.backendKey ?? '',
    provider.enabled,
    provider.type,
    credentialSummary(provider.apiKey),
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
  invalidateProviderCatalogSync(providerId)
  const generation = providerCatalogSyncGenerations.get(providerId)!
  const fingerprint = providerCatalogSyncFingerprint(provider, effectiveBaseUrl)
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
