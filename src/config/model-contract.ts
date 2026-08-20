import {
  inferCapabilitiesFromId,
  isChatModel,
  PROVIDER_PRESETS,
} from './providers'
import type {
  BackendProviderModelSpec,
  CatalogModel,
  EmbeddingModelContract,
  ModelCapability,
  ModelOption,
  ModelReasoningControl,
  ModelReasoningDialect,
  ModelReasoningSupport,
  ProviderConfig,
} from '@/types'
import { isReasoningEffort } from '@/utils/reasoning-policy'

const CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS = new Set([
  'nvidia/nemotron-3-embed-1b:free',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
])

const OPENROUTER_EMBEDDING_CONTRACT: EmbeddingModelContract = {
  protocol: 'openai_embeddings',
  dimension: 2048,
  normalization: 'l2',
}

function cloneEmbeddingContract(
  embedding: EmbeddingModelContract | undefined,
): EmbeddingModelContract | undefined {
  return embedding ? { ...embedding } : undefined
}

export function embeddingContractForModel(
  model: Pick<ModelOption, 'id' | 'capabilities' | 'embedding'>,
): EmbeddingModelContract | undefined {
  if (CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS.has(model.id)) {
    return { ...OPENROUTER_EMBEDDING_CONTRACT }
  }
  if (model.embedding) return cloneEmbeddingContract(model.embedding)
  return undefined
}

/** These two provider-owned IDs are embedding-only regardless of stale/incorrect client metadata. */
export function normalizeModelCapabilities(
  model: Pick<ModelOption, 'id' | 'capabilities'>,
): ModelCapability[] {
  if (CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS.has(model.id)) {
    return ['embedding']
  }
  return model.capabilities ?? ['text']
}

/** 不可信配置或旧数据只能收敛到精确三态，不能从模型 ID 补猜。 */
export function normalizeModelReasoningSupport(value: unknown): ModelReasoningSupport {
  if (value === 'supported' || value === 'unsupported') return value
  return 'unknown'
}

const MODEL_REASONING_DIALECTS = new Set<ModelReasoningDialect>([
  'reasoning_effort',
  'enable_thinking',
  'think',
  'thinking',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cloneReasoningValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneReasoningValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneReasoningValue(item)]),
  )
}

/** 控制对象只接受精确 Provider 合同，false 是合法 off 值。 */
export function normalizeModelReasoningControl(value: unknown): ModelReasoningControl | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (!MODEL_REASONING_DIALECTS.has(value.dialect as ModelReasoningDialect)) return undefined
  if (value.on == null || value.off == null) return undefined
  if (value.dialect === 'reasoning_effort') {
    if (
      keys.length !== 4 ||
      keys[0] !== 'allowed_efforts' ||
      keys[1] !== 'dialect' ||
      keys[2] !== 'off' ||
      keys[3] !== 'on' ||
      !Array.isArray(value.allowed_efforts) ||
      value.allowed_efforts.length === 0 ||
      !isReasoningEffort(value.on)
    ) {
      return undefined
    }
    const allowedEfforts = value.allowed_efforts
    const unique = new Set<string>()
    for (const effort of allowedEfforts) {
      if (!isReasoningEffort(effort) || unique.has(effort)) return undefined
      unique.add(effort)
    }
    if (!unique.has(value.on)) return undefined
    return {
      dialect: 'reasoning_effort',
      on: value.on,
      off: cloneReasoningValue(value.off),
      allowed_efforts: [...allowedEfforts],
    }
  }
  if (keys.length !== 3 || keys[0] !== 'dialect' || keys[1] !== 'off' || keys[2] !== 'on') {
    return undefined
  }
  return {
    dialect: value.dialect as ModelReasoningDialect,
    on: cloneReasoningValue(value.on),
    off: cloneReasoningValue(value.off),
  }
}

function normalizeModelReasoningContract(
  supportValue: unknown,
  controlValue: unknown,
): { support: ModelReasoningSupport; control?: ModelReasoningControl } {
  const support = normalizeModelReasoningSupport(supportValue)
  const control = normalizeModelReasoningControl(controlValue)
  if (support === 'supported' && control) return { support, control }
  if (support !== 'supported' && control === undefined && controlValue == null) return { support }
  return { support: 'unknown' }
}

/** Ollama 仅以 /api/tags 的 capabilities 字段作为推理能力证据。 */
export function reasoningSupportFromOllamaCapabilities(
  capabilities: readonly string[] | undefined,
): ModelReasoningSupport {
  if (capabilities === undefined) return 'unknown'
  return capabilities.includes('thinking') ? 'supported' : 'unsupported'
}

export function reasoningControlFromOllamaCapabilities(
  capabilities: readonly string[] | undefined,
): ModelReasoningControl | undefined {
  return capabilities?.includes('thinking')
    ? { dialect: 'think', on: true, off: false }
    : undefined
}

/** Canonical model record shared by config ingest, UI creation and persistence. */
export function canonicalizeModelOption(model: ModelOption): ModelOption {
  const capabilities = normalizeModelCapabilities(model)
  const embedding = embeddingContractForModel({ ...model, capabilities })
  const reasoning = normalizeModelReasoningContract(
    model.reasoningSupport,
    model.reasoningControl,
  )
  const modelWithoutReasoningControl = { ...model }
  const hasReasoningDeclaration = hasOwn(model, 'reasoningSupport') || hasOwn(model, 'reasoningControl')
  delete modelWithoutReasoningControl.reasoningControl
  delete modelWithoutReasoningControl.reasoningSupport
  return {
    ...modelWithoutReasoningControl,
    capabilities,
    ...(hasReasoningDeclaration ? { reasoningSupport: reasoning.support } : {}),
    ...(reasoning.control ? { reasoningControl: reasoning.control } : {}),
    ...(embedding ? { embedding } : {}),
  }
}

export function isChatModelOption(
  model: Pick<ModelOption, 'id' | 'capabilities'>,
): boolean {
  return isChatModel(normalizeModelCapabilities(model))
}

export function cloneModels(models: ModelOption[] = []): ModelOption[] {
  return models.map(canonicalizeModelOption)
}

export function resolveProviderSelectedModelId(
  provider: Pick<ProviderConfig, 'models' | 'selectedModelId'>,
  preferredModelId = '',
): string {
  const chatModels = provider.models.filter(isChatModelOption)
  const trimmedPreferredModelId = preferredModelId.trim()
  if (trimmedPreferredModelId && chatModels.some((model) => model.id === trimmedPreferredModelId)) {
    return trimmedPreferredModelId
  }

  const currentSelectedModelId = provider.selectedModelId?.trim() ?? ''
  if (currentSelectedModelId && chatModels.some((model) => model.id === currentSelectedModelId)) {
    return currentSelectedModelId
  }
  return chatModels[0]?.id ?? ''
}

export function mergeProviderModels(
  localProvider: ProviderConfig | undefined,
  backendModelId: string,
  backendModels?: string[],
  backendModelSpecs?: BackendProviderModelSpec[],
): ModelOption[] {
  if (backendModelSpecs !== undefined) {
    const specsByID = new Map(backendModelSpecs.map((model) => [model.id, model]))
    const localByID = new Map((localProvider?.models ?? []).map((model) => [model.id, model]))
    const orderedIDs: string[] = []
    const seen = new Set<string>()
    const append = (id: string) => {
      const normalized = id.trim()
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized)
        orderedIDs.push(normalized)
      }
    }
    for (const id of backendModels ?? []) append(id)
    for (const spec of backendModelSpecs) append(spec.id)
    if (orderedIDs.length === 0) append(backendModelId)

    return cloneModels(orderedIDs.map((id) => {
      const spec = specsByID.get(id)
      const local = localByID.get(id)
      if (!spec) {
        const localReasoningSupport = local?.reasoningSupport === undefined
          ? undefined
          : normalizeModelReasoningSupport(local.reasoningSupport)
        return {
          id,
          name: local?.name || id,
          ...(local?.isCustom === undefined ? {} : { isCustom: local.isCustom }),
          capabilities: [] as ModelCapability[],
          ...(localReasoningSupport === undefined ? {} : { reasoningSupport: localReasoningSupport }),
          ...(local?.reasoningControl ? { reasoningControl: local.reasoningControl } : {}),
          ...(local?.embedding ? { embedding: local.embedding } : {}),
        }
      }
      const hasBackendReasoningSupport = hasOwn(spec, 'reasoning_support')
      const hasBackendReasoningControl = hasOwn(spec, 'reasoning_control')
      const presetReasoning = !hasBackendReasoningSupport && !hasBackendReasoningControl && localProvider
        ? PROVIDER_PRESETS[localProvider.type]?.defaultModels.find((model) => model.id === id)
        : undefined
      const localPreset = presetReasoning ? canonicalizeModelOption(presetReasoning) : undefined
      const isCustom = spec.is_custom ?? local?.isCustom
      const reasoningSupport = hasBackendReasoningSupport
        ? normalizeModelReasoningSupport(spec.reasoning_support)
        : localPreset?.reasoningSupport
      return {
        id,
        name: spec.display_name || local?.name || id,
        ...(isCustom === undefined ? {} : { isCustom }),
        // Field presence is part of the compatibility contract: an omitted
        // per-model capability list is legacy text, while an explicit [] is
        // intentionally unclassified and must remain empty.
        capabilities: spec.capabilities === undefined ? ['text'] : spec.capabilities,
        ...(reasoningSupport === undefined ? {} : { reasoningSupport }),
        ...(hasBackendReasoningControl
          ? spec.reasoning_control === undefined ? {} : { reasoningControl: spec.reasoning_control }
          : localPreset?.reasoningControl ? { reasoningControl: localPreset.reasoningControl } : {}),
        ...(spec.embedding === undefined ? {} : { embedding: spec.embedding }),
      }
    }))
  }

  const localModels = cloneModels(localProvider?.models ?? [])
  for (const modelId of backendModels ?? []) {
    const id = modelId.trim()
    if (id && !localModels.some((model) => model.id === id)) {
      localModels.push(canonicalizeModelOption({
        id,
        name: id,
        capabilities: normalizeModelCapabilities({ id }),
      }))
    }
  }

  const trimmedBackendModelId = backendModelId.trim()
  if (trimmedBackendModelId && !localModels.some((model) => model.id === trimmedBackendModelId)) {
    localModels.unshift(canonicalizeModelOption({
      id: trimmedBackendModelId,
      name: trimmedBackendModelId,
      capabilities: normalizeModelCapabilities({ id: trimmedBackendModelId }),
    }))
  }
  return localModels
}

export function mergeRemoteModelsIntoProvider(
  target: ProviderConfig,
  remoteModels: CatalogModel[],
  presetDefaults: ModelOption[],
): void {
  const existing = new Set(target.models.map((model) => model.id))
  const presetCaps = new Map(presetDefaults.map((model) => [model.id, model.capabilities]))
  const presetReasoningSupport = new Map(
    presetDefaults.map((model) => [model.id, model.reasoningSupport]),
  )
  const presetReasoningControl = new Map(
    presetDefaults.map((model) => [model.id, model.reasoningControl]),
  )
  for (const remoteModel of remoteModels) {
    if (existing.has(remoteModel.id)) continue
    target.models.push(canonicalizeModelOption({
      id: remoteModel.id,
      name: remoteModel.name || remoteModel.id,
      capabilities: presetCaps.get(remoteModel.id) ?? inferCapabilitiesFromId(remoteModel.id),
      reasoningSupport:
        remoteModel.reasoningSupport ?? presetReasoningSupport.get(remoteModel.id),
      reasoningControl:
        remoteModel.reasoningControl ?? presetReasoningControl.get(remoteModel.id),
    }))
  }
}

export function isOllamaProvider(
  provider: Pick<ProviderConfig, 'type' | 'backendKey' | 'name'>,
): boolean {
  return provider.type === 'ollama' ||
    Boolean(provider.backendKey?.toLowerCase().includes('ollama')) ||
    Boolean(provider.name?.toLowerCase().includes('ollama'))
}

export interface AvailableChatModel {
  providerId: string
  providerKey: string
  providerName: string
  modelId: string
  modelName: string
  capabilities: ModelCapability[]
  reasoningSupport: ModelReasoningSupport
  reasoningControl?: ModelReasoningControl
}

export function collectAvailableChatModels(
  providers: ProviderConfig[],
  ollamaModels: ModelOption[],
): AvailableChatModel[] {
  const available: AvailableChatModel[] = []
  for (const provider of providers) {
    const models = isOllamaProvider(provider) ? ollamaModels : provider.models
    for (const model of models) {
      const canonical = canonicalizeModelOption(model)
      if (!isChatModelOption(canonical)) continue
      available.push({
        providerId: provider.id,
        providerKey: provider.backendKey || provider.name || provider.id,
        providerName: provider.name,
        modelId: canonical.id,
        modelName: canonical.name,
        capabilities: normalizeModelCapabilities(canonical),
        reasoningSupport: normalizeModelReasoningSupport(canonical.reasoningSupport),
        ...(canonical.reasoningControl
          ? { reasoningControl: canonical.reasoningControl }
          : {}),
      })
    }
  }
  return available
}
