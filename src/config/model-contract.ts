import { isChatModel, PROVIDER_PRESETS } from './providers'
import type {
  BackendProviderModelSpec,
  CatalogModel,
  EmbeddingModelContract,
  ModelCapability,
  ModelCapabilitiesSource,
  ModelCapabilityProbeReceipt,
  ModelCapabilityState,
  ModelOption,
  ModelReasoningControl,
  ModelReasoningDialect,
  ModelReasoningSupport,
  ProviderConfig,
  ReasoningPolicy,
} from '@/types'
import { cloneReasoningPolicy, isReasoningEffort, normalizeReasoningPolicy } from '@/utils/reasoning-policy'

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
  model: Pick<ModelOption, 'id' | 'capabilities' | 'capabilitiesSource' | 'embedding'>,
): EmbeddingModelContract | undefined {
  if (model.capabilitiesSource === 'manual' && !model.capabilities?.includes('embedding')) return undefined
  if (CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS.has(model.id)) {
    return { ...OPENROUTER_EMBEDDING_CONTRACT }
  }
  if (model.embedding) return cloneEmbeddingContract(model.embedding)
  return undefined
}

/** 精确 embedding 旧预设兼容不覆盖明确的手工声明。 */
export function normalizeModelCapabilities(
  model: Pick<ModelOption, 'id' | 'capabilities' | 'capabilitiesSource'>,
): ModelCapability[] {
  if (model.capabilitiesSource === 'manual') return model.capabilities ?? ['text']
  if (CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS.has(model.id)) {
    return ['embedding']
  }
  return model.capabilities ?? ['text']
}

/** 持久化只使用声明，不能把探测得到的有效能力写回配置。 */
export function declaredModelCapabilities(model: ModelOption): ModelCapability[] {
  return [...normalizeModelCapabilities({
    id: model.id,
    capabilities: model.declaredCapabilities ?? model.capabilities,
    capabilitiesSource: model.capabilitiesSource,
  })]
}

/** 手工能力修改同时更新声明与本地显示，来源指纹仍由服务端签发。 */
export function applyManualModelCapabilities(
  model: ModelOption,
  capabilities: readonly ModelCapability[],
): ModelOption {
  return {
    ...model,
    capabilities: [...capabilities],
    declaredCapabilities: [...capabilities],
    capabilitiesSource: 'manual',
    capabilitiesMetadataPresent: undefined,
  }
}

/** 没有机器声明的目录空能力表示未知；明确空数组与手工声明分别保留原义。 */
export function mergeCatalogModelCapabilities(
  catalogModel: Pick<CatalogModel, 'capabilities' | 'capabilitiesMetadataPresent'>,
  existingModel?: Pick<ModelOption, 'id' | 'capabilities' | 'declaredCapabilities' | 'capabilitiesSource'>,
  acceptLegacy = false,
): ModelCapability[] {
  if (existingModel && (
    existingModel.capabilitiesSource === 'manual' ||
    (!acceptLegacy && (existingModel.capabilitiesSource === 'legacy_unknown' ||
      (!existingModel.capabilitiesSource && existingModel.capabilities !== undefined)))
  )) return [...normalizeModelCapabilities(existingModel)]
  const capabilities = catalogModel.capabilitiesMetadataPresent || catalogModel.capabilities?.length
    ? catalogModel.capabilities ?? []
    : existingModel
      ? normalizeModelCapabilities(existingModel)
      : catalogModel.capabilities ?? []
  return [...capabilities]
}

/** 同时应用目录能力及其来源，避免展示与持久声明分叉。 */
export function applyCatalogModelCapabilities(
  model: ModelOption,
  catalogModel: Pick<CatalogModel, 'capabilities' | 'capabilitiesSource' | 'capabilitiesSourceFingerprint' | 'capabilitiesMetadataPresent'>,
  acceptLegacy = false,
): ModelOption {
  if ((!catalogModel.capabilitiesMetadataPresent && !catalogModel.capabilities?.length) || model.capabilitiesSource === 'manual') return { ...model }
  const source = model.capabilitiesSource
  if (!acceptLegacy && (source === 'legacy_unknown' || (!source && model.capabilities !== undefined))) {
    return { ...model }
  }
  const capabilities = mergeCatalogModelCapabilities(catalogModel, model, acceptLegacy)
  return {
    ...model,
    capabilities,
    declaredCapabilities: [...capabilities],
    capabilitiesSource: catalogModel.capabilitiesSource ?? 'catalog',
    capabilitiesSourceFingerprint: catalogModel.capabilitiesSourceFingerprint,
    capabilitiesMetadataPresent: catalogModel.capabilitiesMetadataPresent,
  }
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

export type ReasoningModelState = 'controllable' | 'native' | 'unsupported' | 'unknown'

/** 原生推理证据与可操作的控制合同独立，所有入口读取同一只读状态。 */
export function reasoningModelState(model?: Pick<ModelOption,
  'reasoningSupport' | 'reasoningControl' | 'nativeReasoningSupport' | 'effectiveNativeReasoningSupport'
>): ReasoningModelState {
  if (model?.reasoningSupport === 'supported' && normalizeModelReasoningControl(model.reasoningControl)) {
    return 'controllable'
  }
  const nativeSupport = model?.effectiveNativeReasoningSupport ?? model?.nativeReasoningSupport
  if (nativeSupport === 'supported') return 'native'
  if (model?.reasoningSupport === 'unsupported' || nativeSupport === 'unsupported') return 'unsupported'
  return 'unknown'
}

/** 模型切换只投影当前可执行策略，不改写保存的强度偏好。 */
export function projectReasoningPolicyForModel(
  policyValue: unknown,
  model?: Pick<ModelOption, 'reasoningSupport' | 'reasoningControl'>,
): ReasoningPolicy {
  const policy = normalizeReasoningPolicy(policyValue)
  const control = normalizeModelReasoningControl(model?.reasoningControl)
  if (policy.mode === 'effort' && model?.reasoningSupport === 'supported' && control &&
    (control.dialect !== 'reasoning_effort' || !control.allowed_efforts?.includes(policy.effort))) {
    return { mode: 'auto' }
  }
  return cloneReasoningPolicy(policy)
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
  return capabilities?.includes('thinking') ? { dialect: 'think', on: true, off: false } : undefined
}

/** Canonical model record shared by config ingest, UI creation and persistence. */
export function canonicalizeModelOption(model: ModelOption): ModelOption {
  const capabilities = [...normalizeModelCapabilities(model)]
  const embedding = embeddingContractForModel({ ...model, capabilities })
  const reasoning = normalizeModelReasoningContract(model.reasoningSupport, model.reasoningControl)
  const modelWithoutReasoningControl = { ...model }
  const hasReasoningDeclaration =
    hasOwn(model, 'reasoningSupport') || hasOwn(model, 'reasoningControl')
  delete modelWithoutReasoningControl.reasoningControl
  delete modelWithoutReasoningControl.reasoningSupport
  if (model.capabilitiesSource === 'manual' && !capabilities.includes('embedding')) delete modelWithoutReasoningControl.embedding
  return {
    ...modelWithoutReasoningControl,
    capabilities,
    ...(model.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: declaredModelCapabilities(model) }),
    ...(hasReasoningDeclaration ? { reasoningSupport: reasoning.support } : {}),
    ...(reasoning.control ? { reasoningControl: reasoning.control } : {}),
    ...(hasOwn(model, 'nativeReasoningSupport')
      ? { nativeReasoningSupport: normalizeModelReasoningSupport(model.nativeReasoningSupport) }
      : {}),
    ...(hasOwn(model, 'effectiveNativeReasoningSupport')
      ? { effectiveNativeReasoningSupport: normalizeModelReasoningSupport(model.effectiveNativeReasoningSupport) }
      : {}),
    ...(embedding ? { embedding } : {}),
  }
}

/** 目录声明缺省保留同来源值；显式未知与来源变化均不得被旧声明补回。 */
export function applyCatalogNativeReasoningContract(
  model: ModelOption,
  catalogModel: Pick<CatalogModel, 'nativeReasoningSupport' | 'nativeReasoningSourceFingerprint'>,
): ModelOption {
  const next = { ...model }
  const sourceChanged = Boolean(
    catalogModel.nativeReasoningSourceFingerprint &&
    model.nativeReasoningSourceFingerprint !== catalogModel.nativeReasoningSourceFingerprint,
  )
  const declarationChanged =
    hasOwn(catalogModel, 'nativeReasoningSupport') &&
    normalizeModelReasoningSupport(catalogModel.nativeReasoningSupport) !==
      normalizeModelReasoningSupport(model.nativeReasoningSupport)
  if (hasOwn(catalogModel, 'nativeReasoningSupport')) {
    next.nativeReasoningSupport = normalizeModelReasoningSupport(catalogModel.nativeReasoningSupport)
  } else if (sourceChanged && hasOwn(model, 'nativeReasoningSupport')) {
    next.nativeReasoningSupport = 'unknown'
  }
  if (hasOwn(catalogModel, 'nativeReasoningSourceFingerprint')) {
    next.nativeReasoningSourceFingerprint = catalogModel.nativeReasoningSourceFingerprint
  }
  if (
    (sourceChanged &&
      model.effectiveNativeReasoningSourceFingerprint !== catalogModel.nativeReasoningSourceFingerprint) ||
    (declarationChanged &&
      normalizeModelReasoningSupport(model.effectiveNativeReasoningSupport) ===
        normalizeModelReasoningSupport(model.nativeReasoningSupport))
  ) {
    // 由旧静态声明形成的有效快照随声明更新失效，独立的同来源正证继续保留。
    delete next.effectiveNativeReasoningSupport
    delete next.effectiveNativeReasoningSourceFingerprint
  }
  return next
}

/** 只废止原生推理来源，不影响文本能力和已有控制合同。 */
export function invalidateModelNativeReasoning(model: ModelOption): ModelOption {
  const next = { ...model }
  if (hasOwn(next, 'nativeReasoningSupport')) next.nativeReasoningSupport = 'unknown'
  delete next.nativeReasoningSourceFingerprint
  delete next.effectiveNativeReasoningSupport
  delete next.effectiveNativeReasoningSourceFingerprint
  return next
}

function reasoningContractFromModel(
  ...sources: Array<ModelOption | undefined>
): Partial<Pick<ModelOption, 'reasoningSupport' | 'reasoningControl'>> {
  for (const source of sources) {
    if (!source) continue
    const canonical = canonicalizeModelOption(source)
    const hasSupport = hasOwn(canonical, 'reasoningSupport')
    const hasControl = hasOwn(canonical, 'reasoningControl')
    if (!hasSupport && !hasControl) continue
    return {
      ...(hasSupport ? { reasoningSupport: canonical.reasoningSupport } : {}),
      ...(hasControl ? { reasoningControl: canonical.reasoningControl } : {}),
    }
  }
  return {}
}

export function isChatModelOption(model: Pick<ModelOption, 'id' | 'capabilities'>): boolean {
  if (CANONICAL_OPENROUTER_EMBEDDING_MODEL_IDS.has(model.id)) return false
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

/** 服务端只读模型有效投影。 */
export interface EffectiveProviderModelProjection {
  id: string
  display_name?: string
  capabilities: ModelCapability[]
  declared_capabilities?: ModelCapability[]
  capabilities_source?: ModelCapabilitiesSource
  capabilities_source_fingerprint?: string
  capabilities_metadata_present?: boolean
  capability_states?: Record<string, ModelCapabilityState>
  probe_receipts?: ModelCapabilityProbeReceipt[]
  effective_native_reasoning_support?: ModelReasoningSupport
  native_reasoning_source_fingerprint?: string
}

export function mergeProviderModels(
  localProvider: ProviderConfig | undefined,
  backendModelId: string,
  backendModels?: string[],
  backendModelSpecs?: BackendProviderModelSpec[],
  backendEffectiveModels?: EffectiveProviderModelProjection[],
  modelSpecsMode?: ProviderConfig['modelSpecsMode'],
): ModelOption[] {
  if (backendModelSpecs !== undefined || backendEffectiveModels !== undefined) {
    const specsByID = new Map((backendModelSpecs ?? []).map((model) => [model.id, model]))
    const effectiveModelsByID = new Map(
      (backendEffectiveModels ?? []).map((model) => [model.id, model]),
    )
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
    for (const spec of backendModelSpecs ?? []) append(spec.id)
    for (const effectiveModel of backendEffectiveModels ?? []) append(effectiveModel.id)
    if (orderedIDs.length === 0) append(backendModelId)

    return cloneModels(
      orderedIDs.map((id) => {
        const spec = specsByID.get(id)
        const effectiveModel = effectiveModelsByID.get(id)
        const local = localByID.get(id)
        const nativeModel = applyCatalogNativeReasoningContract(
          local ?? { id, name: id },
          {
            ...(spec && hasOwn(spec, 'native_reasoning_support')
              ? { nativeReasoningSupport: normalizeModelReasoningSupport(spec.native_reasoning_support) }
              : {}),
            ...(spec?.native_reasoning_source_fingerprint || effectiveModel?.native_reasoning_source_fingerprint
              ? { nativeReasoningSourceFingerprint: spec?.native_reasoning_source_fingerprint || effectiveModel?.native_reasoning_source_fingerprint }
              : {}),
          },
        )
        const nativeFields = {
          ...(nativeModel.nativeReasoningSupport === undefined ? {} : { nativeReasoningSupport: nativeModel.nativeReasoningSupport }),
          ...(nativeModel.nativeReasoningSourceFingerprint ? { nativeReasoningSourceFingerprint: nativeModel.nativeReasoningSourceFingerprint } : {}),
          ...(effectiveModel && hasOwn(effectiveModel, 'effective_native_reasoning_support')
            ? {
                effectiveNativeReasoningSupport: normalizeModelReasoningSupport(effectiveModel.effective_native_reasoning_support),
                effectiveNativeReasoningSourceFingerprint: effectiveModel.native_reasoning_source_fingerprint,
              }
            : {}),
        }
        if (!spec && !effectiveModel) {
          const localReasoningSupport =
            local?.reasoningSupport === undefined
              ? undefined
              : normalizeModelReasoningSupport(local.reasoningSupport)
          return {
            id,
            name: local?.name || id,
            ...(local?.isCustom === undefined ? {} : { isCustom: local.isCustom }),
            capabilities: [] as ModelCapability[],
            ...(localReasoningSupport === undefined
              ? {}
              : { reasoningSupport: localReasoningSupport }),
            ...(local?.reasoningControl ? { reasoningControl: local.reasoningControl } : {}),
            ...(local?.embedding ? { embedding: local.embedding } : {}),
            ...nativeFields,
          }
        }
        const hasBackendReasoningSupport = spec !== undefined && hasOwn(spec, 'reasoning_support')
        const hasBackendReasoningControl = spec !== undefined && hasOwn(spec, 'reasoning_control')
        const presetReasoning =
          !hasBackendReasoningSupport && !hasBackendReasoningControl && localProvider
            ? PROVIDER_PRESETS[localProvider.type]?.defaultModels.find((model) => model.id === id)
            : undefined
        const localPreset = presetReasoning ? canonicalizeModelOption(presetReasoning) : undefined
        // 后端仅返回 effective_models 或旧 model_specs 时，不得抹掉本地已持久化的精确合同。
        // 只有本地没有声明时，才回退到同 ID 的静态预设；后端显式字段仍拥有最高优先级。
        const omittedReasoning =
          !hasBackendReasoningSupport && !hasBackendReasoningControl
            ? reasoningContractFromModel(
                local ? canonicalizeModelOption(local) : undefined,
                localPreset,
              )
            : {}
        const isCustom = spec?.is_custom ?? local?.isCustom
        const declaredCapabilities = spec
          ? spec.capabilities ?? ['text'] as ModelCapability[]
          : effectiveModel?.declared_capabilities ?? local?.declaredCapabilities ?? local?.capabilities ?? []
        const capabilitiesSource = spec?.capabilities_source ?? effectiveModel?.capabilities_source ??
          (spec && modelSpecsMode !== 'legacy' ? 'legacy_unknown' : local?.capabilitiesSource)
        const capabilitiesSourceFingerprint = spec?.capabilities_source_fingerprint ??
          effectiveModel?.capabilities_source_fingerprint
        const capabilitiesMetadataPresent = spec
          ? spec.capabilities_metadata_present
          : effectiveModel?.capabilities_metadata_present ?? local?.capabilitiesMetadataPresent
        const reasoningSupport = hasBackendReasoningSupport
          ? normalizeModelReasoningSupport(spec?.reasoning_support)
          : omittedReasoning.reasoningSupport
        return {
          id,
          name: effectiveModel?.display_name || spec?.display_name || local?.name || id,
          ...(isCustom === undefined ? {} : { isCustom }),
          // Field presence is part of the compatibility contract: an omitted
          // per-model capability list is legacy text, while an explicit [] is
          // intentionally unclassified and must remain empty.
          capabilities:
            effectiveModel?.capabilities ??
            (spec === undefined
              ? []
              : spec.capabilities === undefined
                ? ['text']
                : spec.capabilities),
          ...(declaredCapabilities === undefined ? {} : { declaredCapabilities: [...declaredCapabilities] }),
          ...(capabilitiesSource ? { capabilitiesSource } : {}),
          ...(capabilitiesSourceFingerprint ? { capabilitiesSourceFingerprint } : {}),
          ...(capabilitiesMetadataPresent === undefined ? {} : { capabilitiesMetadataPresent }),
          ...(effectiveModel?.capability_states ? { capabilityStates: { ...effectiveModel.capability_states } } : {}),
          ...(effectiveModel?.probe_receipts ? { probeReceipts: effectiveModel.probe_receipts.map((receipt) => ({ ...receipt })) } : {}),
          ...(reasoningSupport === undefined ? {} : { reasoningSupport }),
          ...(hasBackendReasoningControl
            ? spec?.reasoning_control === undefined
              ? {}
              : { reasoningControl: spec.reasoning_control }
            : omittedReasoning.reasoningControl
              ? { reasoningControl: omittedReasoning.reasoningControl }
              : {}),
          ...(spec?.embedding === undefined ? {} : { embedding: spec.embedding }),
          ...nativeFields,
        }
      }),
    )
  }

  const localModels = cloneModels(localProvider?.models ?? [])
  for (const modelId of backendModels ?? []) {
    const id = modelId.trim()
    if (id && !localModels.some((model) => model.id === id)) {
      localModels.push(
        canonicalizeModelOption({
          id,
          name: id,
          capabilities: normalizeModelCapabilities({ id }),
        }),
      )
    }
  }

  const trimmedBackendModelId = backendModelId.trim()
  if (trimmedBackendModelId && !localModels.some((model) => model.id === trimmedBackendModelId)) {
    localModels.unshift(
      canonicalizeModelOption({
        id: trimmedBackendModelId,
        name: trimmedBackendModelId,
        capabilities: normalizeModelCapabilities({ id: trimmedBackendModelId }),
      }),
    )
  }
  return localModels
}

export function mergeRemoteModelsIntoProvider(
  target: ProviderConfig,
  remoteModels: CatalogModel[],
  presetDefaults: ModelOption[],
): void {
  const existing = new Set(target.models.map((model) => model.id))
  const presetCaps = new Map(presetDefaults.map((model) => [model.id, model.capabilities ?? []]))
  const presetReasoningSupport = new Map(
    presetDefaults.map((model) => [model.id, model.reasoningSupport]),
  )
  const presetReasoningControl = new Map(
    presetDefaults.map((model) => [model.id, model.reasoningControl]),
  )
  for (const remoteModel of remoteModels) {
    if (existing.has(remoteModel.id)) continue
    const presetCapabilities = presetCaps.get(remoteModel.id)
    target.models.push(
      canonicalizeModelOption(applyCatalogModelCapabilities({
        id: remoteModel.id,
        name: remoteModel.name || remoteModel.id,
        capabilitiesSource: presetCapabilities ? 'preset' : 'catalog',
        capabilities: [...(presetCapabilities ?? [])],
        declaredCapabilities: [...(presetCapabilities ?? [])],
        reasoningSupport:
          remoteModel.reasoningSupport ?? presetReasoningSupport.get(remoteModel.id),
        reasoningControl:
          remoteModel.reasoningControl ?? presetReasoningControl.get(remoteModel.id),
        ...(Object.prototype.hasOwnProperty.call(remoteModel, 'nativeReasoningSupport')
          ? { nativeReasoningSupport: remoteModel.nativeReasoningSupport }
          : {}),
        ...(remoteModel.nativeReasoningSourceFingerprint
          ? { nativeReasoningSourceFingerprint: remoteModel.nativeReasoningSourceFingerprint }
          : {}),
      }, remoteModel)),
    )
  }
}

export function isOllamaProvider(
  provider: Pick<ProviderConfig, 'type' | 'backendKey' | 'name'>,
): boolean {
  return (
    provider.type === 'ollama' ||
    Boolean(provider.backendKey?.toLowerCase().includes('ollama')) ||
    Boolean(provider.name?.toLowerCase().includes('ollama'))
  )
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
  nativeReasoningSupport?: ModelReasoningSupport
  nativeReasoningSourceFingerprint?: string
  effectiveNativeReasoningSupport?: ModelReasoningSupport
  effectiveNativeReasoningSourceFingerprint?: string
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
        ...(canonical.reasoningControl ? { reasoningControl: canonical.reasoningControl } : {}),
        ...(canonical.nativeReasoningSupport === undefined ? {} : { nativeReasoningSupport: canonical.nativeReasoningSupport }),
        ...(canonical.nativeReasoningSourceFingerprint ? { nativeReasoningSourceFingerprint: canonical.nativeReasoningSourceFingerprint } : {}),
        ...(canonical.effectiveNativeReasoningSupport === undefined ? {} : { effectiveNativeReasoningSupport: canonical.effectiveNativeReasoningSupport }),
        ...(canonical.effectiveNativeReasoningSourceFingerprint ? { effectiveNativeReasoningSourceFingerprint: canonical.effectiveNativeReasoningSourceFingerprint } : {}),
      })
    }
  }
  return available
}
