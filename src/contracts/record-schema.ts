/**
 * 记录集 schema：字段声明 + 状态机（领域无关的记录本原语 · 架构 §7.3 / §5.2.3）。
 *
 * 平台原语：表结构领域无关，任意业务记录集都是一个 collection。领域字段进 `fields`（JSON 载体），
 * 通用基建列（recordId / agentId 不可变 / schemaVersion / status / dedupeKey / dueAt …）typed。
 * 禁止把场景领域列提升为顶层 typed 列（§9.3 Don'ts #1）。
 */

/** 字段类型 */
export type RecordFieldType = 'string' | 'text' | 'number' | 'date' | 'enum' | 'tags'

/** 字段在记录行中的呈现角色（驱动通用记录视图渲染，shell 不硬编码字段名） */
export type RecordFieldRole = 'title' | 'chip' | 'meta' | 'status' | 'date' | 'source'

export interface RecordFieldSpec {
  key: string
  labelKey: string
  type: RecordFieldType
  /** enum 选项 i18n 前缀 */
  enumKey?: string
  role?: RecordFieldRole
}

/** 状态色调（通用记录视图据此上色，非领域语义） */
export type RecordStateTone = 'todo' | 'done' | 'got' | 'na'

export interface RecordStateSpec {
  id: string
  labelKey: string
  tone?: RecordStateTone
}

export interface RecordTransition {
  from: string
  to: string
  /** 转移条件描述（提示/文档用） */
  labelKey?: string
}

/** 记录集 schema 声明 */
export interface RecordSchema {
  collection: string
  schemaVersion: string
  labelKey: string
  fields: RecordFieldSpec[]
  /** 状态机；纯积累型集合可省略（无状态） */
  states?: RecordStateSpec[]
  transitions?: RecordTransition[]
  /** 去重键字段（幂等写，呼应全表 UNIQUE 防重 §7.6） */
  dedupeKey?: string[]
  /** 列表默认排序字段（记录项 fields 内的 key 或基建列名） */
  orderBy?: string
  /** 是否为复习型集合（带到期/掌握度队列，驱动复习引擎 UI） */
  reviewable?: boolean
}

/**
 * 通用记录项：typed 基建列 + 领域字段 JSON。
 * 多孩隔离 = 以不可变 `agentId` 为查询边界（禁用可变显示名 · §9.3 Don'ts #10）。
 */
export interface RecordItem {
  recordId: string
  /** 不可变隔离键 */
  agentId: string
  collection: string
  schemaVersion: string
  status?: string
  /** 领域字段（按 schema.fields 校验/渲染） */
  fields: Record<string, unknown>
  tags?: string[]
  /** 到期时间 unix 秒（复习队列排程；无调度为 null，对齐后端 due_at *int64） */
  dueAt?: number | null
  /** 来源会话（跳回原对话） */
  sourceSessionId?: string | null
  /** 创建/更新时间 unix 秒（后端 created_at/updated_at int64；DTO 未回传时缺省） */
  createdAt?: number
  updatedAt?: number
  version: number
}

/** 记录集聚合视图（列表 + 复习队列 + 统计，供记录视图/报告消费） */
export interface RecordCollectionView {
  collection: string
  schemaVersion: string
  items: RecordItem[]
  /** 复习队列（reviewable 集合才有）：到期需练的记录 id */
  reviewQueue?: string[]
  /** 状态计数（按 status id） */
  statusCounts?: Record<string, number>
  /** 后端返回的全量记录数；筛选/权限投影后 items 可少于该值。 */
  totalCount?: number
}
