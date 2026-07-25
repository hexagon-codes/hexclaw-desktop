/**
 * K12 记录集 schema 声明（错题本 / 积累本）· 架构 §7.3 走 RecordSchemaRegistry。
 *
 * 这是 **K12 唯一前端落点**（features/k12）；平台记录本原语（RecordSchema/RecordItem）领域无关，
 * 领域字段（知识点/错因…）进 fields，状态机由本声明提供。第二场景（积累本）复用同一原语、
 * 不复用错题 schema（架构 §10 验证原语平台价值）。
 */
import type { RecordSchema } from '@/contracts'

/**
 * 错题本：5 态状态机（对齐后端 scenarios/k12/k12.go:27-33）：
 * new(新录入) → explained(已讲解) → retried(已重做) → mastered(已掌握) → archived(已归档)。
 * 字段名 1:1 对齐后端 mistakeDTO（question/knowledge_point/error_cause），reviewable（有到期队列）。
 * collection id = 后端 CollectionMistakes «错题本»（GET /api/k12/mistakes 固定路由，id 仅用于前端 registry keying）。
 */
export const MISTAKE_COLLECTION = '错题本'

export const MISTAKE_SCHEMA: RecordSchema = {
  collection: MISTAKE_COLLECTION,
  schemaVersion: '1',
  labelKey: 'k12.collections.mistakes',
  reviewable: true,
  orderBy: 'due_at',
  dedupeKey: ['question'],
  fields: [
    { key: 'question', labelKey: 'k12.mistakeFields.title', type: 'string', role: 'title' },
    {
      key: 'knowledge_point',
      labelKey: 'k12.mistakeFields.knowledgePoint',
      type: 'string',
      role: 'chip',
    },
    { key: 'error_cause', labelKey: 'k12.mistakeFields.errorCause', type: 'string', role: 'meta' },
  ],
  states: [
    { id: 'new', labelKey: 'k12.mistakeStatus.new', tone: 'todo' },
    { id: 'explained', labelKey: 'k12.mistakeStatus.explained', tone: 'todo' },
    { id: 'retried', labelKey: 'k12.mistakeStatus.retried', tone: 'done' },
    { id: 'mastered', labelKey: 'k12.mistakeStatus.mastered', tone: 'got' },
    { id: 'archived', labelKey: 'k12.mistakeStatus.archived', tone: 'na' },
  ],
  transitions: [
    { from: 'new', to: 'explained' },
    { from: 'explained', to: 'retried' },
    { from: 'retried', to: 'mastered' },
    { from: 'mastered', to: 'archived' },
  ],
}

export const ACCUMULATION_COLLECTION = '积累本'

/** 积累本：语/英沉淀；字段对齐后端 accumDTO（subject/entry_type/content）；与错题本同框架不同记录集 */
export const ACCUMULATION_SCHEMA: RecordSchema = {
  collection: ACCUMULATION_COLLECTION,
  schemaVersion: '1',
  labelKey: 'k12.collections.accumulation',
  reviewable: false,
  fields: [
    { key: 'content', labelKey: 'k12.accumulationFields.content', type: 'string', role: 'title' },
    { key: 'subject', labelKey: 'k12.accumulationFields.subject', type: 'string', role: 'chip' },
    { key: 'entry_type', labelKey: 'k12.accumulationFields.type', type: 'string', role: 'chip' },
    { key: 'source', labelKey: 'k12.accumulationFields.source', type: 'string', role: 'meta' },
  ],
}

export const K12_SCHEMAS: RecordSchema[] = [MISTAKE_SCHEMA, ACCUMULATION_SCHEMA]
