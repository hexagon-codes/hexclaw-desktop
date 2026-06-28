import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { MemoryEntry, MemoryListResponse, MemoryType, MemorySource, MemoryViewMode } from '@/types'

export type { MemoryEntry, MemoryListResponse }

export interface MemoryListParams extends Record<string, unknown> {
  view?: MemoryViewMode
  limit?: number
  cursor?: string
  type?: MemoryType
  source?: MemorySource
}

interface LegacyMemoryResponse {
  content?: string
  context?: string
}

const LEGACY_MEMORY_DEFAULT_MAX = 200

function splitLegacyMemoryBlocks(content: string): string[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  return trimmed
    .split(/\r?\n+(?=- \[\d{1,2}:\d{2}\]\s)/)
    .map((block) => block.trim())
    .filter(Boolean)
}

function parseLegacyMemoryEntries(content: string): MemoryEntry[] {
  const blocks = splitLegacyMemoryBlocks(content)

  return blocks.map((block, index) => {
    let normalized = block.replace(/^-\s*/, '').trim()
    normalized = normalized.replace(/^\[\d{1,2}:\d{2}\]\s*/, '').trim()
    let type: MemoryType = 'fact'
    let source: MemorySource = 'manual'
    const metaMatch = /^\[([^:\]]+):([^\]]+)\]\s*/.exec(normalized)
    if (metaMatch) {
      type = metaMatch[1] as MemoryType
      source = metaMatch[2] as MemorySource
      normalized = normalized.slice(metaMatch[0].length).trim()
    }
    return {
      id: `legacy-${index + 1}`,
      content: normalized,
      type,
      source,
      created_at: '',
      updated_at: '',
      hit_count: 0,
      status: 'active',
    }
  })
}

function normalizeMemoryListResponse(response: MemoryListResponse | LegacyMemoryResponse): MemoryListResponse {
  if (Array.isArray((response as MemoryListResponse).entries)) {
    return response as MemoryListResponse
  }

  const legacy = response as LegacyMemoryResponse
  const entries = parseLegacyMemoryEntries(legacy.content ?? '')

  return {
    entries,
    summary: legacy.context ?? legacy.content ?? '',
    capacity: {
      used: entries.length,
      max: Math.max(entries.length, LEGACY_MEMORY_DEFAULT_MAX),
    },
    legacy_mode: true,
    legacy_content: legacy.content ?? '',
    total: entries.length,
    has_more: false,
  }
}

function parseLegacyEntryIndex(id: string): number {
  const match = /^legacy-(\d+)$/.exec(id)
  if (!match) {
    throw new Error(`Invalid legacy memory ID: ${id}`)
  }
  const index = Number(match[1]) - 1
  if (index < 0) {
    throw new Error(`Invalid legacy memory index: ${id}`)
  }
  return index
}

function replaceLegacyBlockContent(block: string, newContent: string): string {
  const prefixMatch = /^(-\s*(?:\[\d{1,2}:\d{2}\]\s*)?(?:\[[^:\]]+:[^\]]+\]\s*)?)/.exec(block)
  const prefix = prefixMatch?.[1] ?? '- '
  return `${prefix}${newContent.trim()}`
}

/** 获取记忆列表 */
export async function getMemoryEntries(params?: MemoryListParams) {
  const response = params
    ? await apiGet<MemoryListResponse | LegacyMemoryResponse>('/api/v1/memory', params)
    : await apiGet<MemoryListResponse | LegacyMemoryResponse>('/api/v1/memory')
  return normalizeMemoryListResponse(response)
}

/** 创建单条记忆 */
export function createMemoryEntry(
  content: string,
  type?: MemoryType,
  source?: MemorySource,
) {
  return apiPost<MemoryEntry>('/api/v1/memory', { content, type: type ?? 'fact', source: source ?? 'manual' })
}

/** 更新单条记忆 */
export function updateMemoryEntry(id: string, content: string) {
  return apiPut<MemoryEntry>(`/api/v1/memory/${encodeURIComponent(id)}`, { content })
}

/** 兼容旧版 sidecar：通过重写整块 MEMORY 内容更新单条 legacy 记忆 */
export async function updateLegacyMemoryEntry(id: string, content: string, legacyContent: string) {
  const blocks = splitLegacyMemoryBlocks(legacyContent)
  const index = parseLegacyEntryIndex(id)
  if (!blocks[index]) {
    throw new Error(`Legacy memory not found: ${id}`)
  }
  blocks[index] = replaceLegacyBlockContent(blocks[index]!, content)
  return apiPut<{ message: string }>('/api/v1/memory', {
    content: blocks.join('\n\n'),
  })
}

/** 删除单条记忆 */
export function deleteMemoryEntry(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}`)
}

/** 兼容旧版 sidecar：通过重写整块 MEMORY 内容删除单条 legacy 记忆 */
export async function deleteLegacyMemoryEntry(id: string, legacyContent: string) {
  const blocks = splitLegacyMemoryBlocks(legacyContent)
  const index = parseLegacyEntryIndex(id)
  if (!blocks[index]) {
    throw new Error(`Legacy memory not found: ${id}`)
  }
  blocks.splice(index, 1)
  if (blocks.length === 0) {
    return clearAllMemory()
  }
  return apiPut<{ message: string }>('/api/v1/memory', {
    content: blocks.join('\n\n'),
  })
}

/** 归档单条活跃记忆 */
export function archiveMemoryEntry(id: string) {
  return apiPost<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}/archive`)
}

/** 恢复单条归档记忆 */
export function restoreMemoryEntry(id: string) {
  return apiPost<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}/restore`)
}

/** 置顶（常驻）单条记忆（U1：逃生口，反思永不自动移动）。 */
export function pinMemoryEntry(id: string) {
  return apiPost<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}/pin`)
}

/** 取消置顶。 */
export function unpinMemoryEntry(id: string) {
  return apiPost<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}/unpin`)
}

/** 清空所有记忆 */
export function clearAllMemory() {
  return apiDelete<{ message: string }>('/api/v1/memory')
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  content: string
  score: number
  source: string
}

/** 后端 /memory/search 的关键词命中是行级 SearchResult（file_memory.go）：
 *  { file, line, content, score } —— 不含 id / type / created_at。 */
interface MemorySearchHit {
  file: string
  line: number
  content: string
  score: number
}

/** 搜索记忆 (关键词 + 语义)
 *  后端关键词命中是行级 {file,line,content,score}，缺 id/type/时间戳；这里投影成 MemoryEntry：
 *  仅为缺失字段补合成默认值（id=file:line、type=fact、created_at=检索时刻），
 *  已是完整条目的命中（带 id/type）则展开置后原样透传。
 *  修复 MemoryView 渲染：:key=undefined 重复警告 / TYPE_COLORS[undefined] / formatTime(undefined)。 */
export async function searchMemory(query: string): Promise<{
  results: MemoryEntry[]
  vector_results: VectorSearchResult[] | null
  total: number
}> {
  const raw = await apiGet<{
    results: MemorySearchHit[] | null
    vector_results: VectorSearchResult[] | null
    total: number
  }>('/api/v1/memory/search', { q: query })
  const stampedAt = new Date().toISOString() // 行级命中无时间戳，落检索时刻供 formatTime 展示
  const results: MemoryEntry[] = (raw.results ?? []).map((hit) => ({
    type: 'fact' as const,
    source: 'system' as const,
    hit_count: 0,
    created_at: stampedAt,
    updated_at: stampedAt,
    id: `${hit.file}:${hit.line}`,
    ...hit,
  }))
  return { results, vector_results: raw.vector_results, total: raw.total }
}
