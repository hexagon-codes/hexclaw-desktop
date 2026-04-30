/**
 * A7 模型 tool_call 能力探测 API 客户端
 *
 * - GET  /api/v1/llm/capabilities          列出所有缓存
 * - POST /api/v1/llm/capabilities/probe    手动触发一次探测
 *
 * 后端 30 天 TTL；前端按需调用：
 *   - Settings 页打开时 fetchCapabilities() 一次性拉取合并到 models
 *   - 用户点 🔄 按钮 → probeCapability() 刷新单条
 */

import { apiGet, apiPost } from './client'
import type { ToolCallReliability, ModelToolReliability } from '@/types/settings'

/** 后端 Capability 原始结构 */
interface BackendCapability {
  provider_name: string
  model_name: string
  tool_call: number // 0=unknown / 1=good / 2=partial / 3=bad
  tool_call_text: ToolCallReliability
  last_probe: string
  probe_error?: string
}

/** 后端返回的单条能力，带 provider/model 标识（用于合并） */
export interface CapabilityRecord {
  providerName: string
  modelName: string
  reliability: ModelToolReliability
}

function toRecord(c: BackendCapability): CapabilityRecord {
  return {
    providerName: c.provider_name,
    modelName: c.model_name,
    reliability: {
      level: c.tool_call_text ?? 'unknown',
      lastProbe: c.last_probe,
      probeError: c.probe_error,
    },
  }
}

/** 拉取所有已缓存能力记录 */
export async function fetchCapabilities(): Promise<CapabilityRecord[]> {
  const data = await apiGet<BackendCapability[]>('/api/v1/llm/capabilities')
  return (data ?? []).map(toRecord)
}

/** 手动触发一次探测并返回最新结果 */
export async function probeCapability(
  provider: string,
  model: string,
): Promise<CapabilityRecord> {
  const data = await apiPost<BackendCapability>(
    `/api/v1/llm/capabilities/probe?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
  )
  return toRecord(data)
}
