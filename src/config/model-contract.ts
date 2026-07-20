import { inferCapabilitiesFromId, isChatModel } from './providers'
import type {
  BackendProviderModelSpec,
  CatalogModel,
  EmbeddingModelContract,
  ModelCapability,
  ModelOption,
  ProviderConfig,
} from '@/types'

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

/** Canonical model record shared by config ingest, UI creation and persistence. */
export function canonicalizeModelOption(model: ModelOption): ModelOption {
  const capabilities = normalizeModelCapabilities(model)
  const embedding = embeddingContractForModel({ ...model, capabilities })
  return {
    ...model,
    capabilities,
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
        return {
          id,
          name: local?.name || id,
          isCustom: local?.isCustom,
          capabilities: [] as ModelCapability[],
          ...(local?.embedding ? { embedding: local.embedding } : {}),
        }
      }
      return {
        id,
        name: spec.display_name || local?.name || id,
        isCustom: spec.is_custom ?? local?.isCustom,
        // Field presence is part of the compatibility contract: an omitted
        // per-model capability list is legacy text, while an explicit [] is
        // intentionally unclassified and must remain empty.
        capabilities: spec.capabilities === undefined ? ['text'] : spec.capabilities,
        ...(spec.embedding === undefined ? {} : { embedding: spec.embedding }),
      }
    }))
  }

  const localModels = cloneModels(localProvider?.models ?? [])
  for (const modelId of backendModels ?? []) {
    const id = modelId.trim()
    if (id && !localModels.some((model) => model.id === id)) {
      localModels.push({ id, name: id, capabilities: normalizeModelCapabilities({ id }) })
    }
  }

  const trimmedBackendModelId = backendModelId.trim()
  if (trimmedBackendModelId && !localModels.some((model) => model.id === trimmedBackendModelId)) {
    localModels.unshift({
      id: trimmedBackendModelId,
      name: trimmedBackendModelId,
      capabilities: normalizeModelCapabilities({ id: trimmedBackendModelId }),
    })
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
  for (const remoteModel of remoteModels) {
    if (existing.has(remoteModel.id)) continue
    target.models.push(canonicalizeModelOption({
      id: remoteModel.id,
      name: remoteModel.name || remoteModel.id,
      capabilities: presetCaps.get(remoteModel.id) ?? inferCapabilitiesFromId(remoteModel.id),
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
}

export function collectAvailableChatModels(
  providers: ProviderConfig[],
  ollamaModels: ModelOption[],
): AvailableChatModel[] {
  const available: AvailableChatModel[] = []
  for (const provider of providers) {
    const models = isOllamaProvider(provider) ? ollamaModels : provider.models
    for (const model of models) {
      if (!isChatModelOption(model)) continue
      available.push({
        providerId: provider.id,
        providerKey: provider.backendKey || provider.name || provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        capabilities: normalizeModelCapabilities(model),
      })
    }
  }
  return available
}
