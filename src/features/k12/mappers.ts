/**
 * K12 后端 DTO → 前端内部契约 映射（features/k12）。
 * 把扁平的 K12 wire 结构投影到平台通用的 RecordItem / VerifyResult，
 * 让通用 shell（RecordList / VerifyBadge）零 K12 知识即可渲染。
 */
import type { RecordItem, RecordCollectionView, VerifyResult, VerifyEvidence } from '@/contracts'
import type { MistakeDTO, GradeResp, EvidenceType, AccumDTO } from '@/api/k12'
import { MISTAKE_COLLECTION, ACCUMULATION_COLLECTION } from './schemas'

const STRONG_EVIDENCE: EvidenceType[] = ['numeric_exec', 'symbolic_exec', 'heterogeneous_model']
function evidenceOf(t: EvidenceType): VerifyEvidence {
  return STRONG_EVIDENCE.includes(t) ? 'program_verified' : 'model_review'
}

/** mistakeDTO → 通用记录项（字段进 fields，与 MISTAKE_SCHEMA.fields 的 key 对齐）。
 *  subject 已知时 chip 显示「学科·知识点」（原型 20260709 学科定色：数学蓝/语文橙/英语紫，
 *  RecordList data-chip 前缀选择器上色）；/mistakes 列表暂不下发 subject（P2 缺口），队列行先亮。 */
export function mistakeToRecord(dto: MistakeDTO, agentId: string, subject?: string): RecordItem {
  const subj = dto.subject || subject
  return {
    recordId: dto.record_id,
    agentId,
    collection: MISTAKE_COLLECTION,
    schemaVersion: '1',
    status: dto.status,
    fields: {
      question: dto.question,
      knowledge_point: subj ? `${subj}·${dto.knowledge_point}` : dto.knowledge_point,
      error_cause: dto.error_cause,
    },
    dueAt: dto.due_at ?? null,
    version: dto.version,
  }
}

/** 错题列表 + 复习队列 → 通用记录集视图 */
export function mistakesToView(
  agentId: string,
  all: MistakeDTO[],
  due: MistakeDTO[],
): RecordCollectionView {
  // review-queue 下发 subject（/mistakes 列表可缺省）：按 record_id 回填，让队列行 chip 有学科前缀
  const subjectById = new Map(due.filter((d) => d.subject).map((d) => [d.record_id, d.subject!]))
  const items = all.map((d) => mistakeToRecord(d, agentId, subjectById.get(d.record_id)))
  const statusCounts: Record<string, number> = {}
  for (const it of items) if (it.status) statusCounts[it.status] = (statusCounts[it.status] ?? 0) + 1
  return {
    collection: MISTAKE_COLLECTION,
    schemaVersion: '1',
    items,
    reviewQueue: due.map((d) => d.record_id),
    statusCounts,
  }
}

/** accumDTO → 通用记录项（字段对齐 ACCUMULATION_SCHEMA） */
export function accumToRecord(dto: AccumDTO, agentId: string): RecordItem {
  return {
    recordId: dto.record_id,
    agentId,
    collection: ACCUMULATION_COLLECTION,
    schemaVersion: '1',
    status: dto.status,
    fields: { subject: dto.subject, entry_type: dto.entry_type, content: dto.content },
    version: 0,
  }
}

export function accumToView(agentId: string, items: AccumDTO[]): RecordCollectionView {
  return {
    collection: ACCUMULATION_COLLECTION,
    schemaVersion: '1',
    items: items.map((d) => accumToRecord(d, agentId)),
  }
}

/** gradeResp → 验算徽章数据（三态诚实，徽章强弱取后端 badge/evidence_type） */
export function gradeToVerify(resp: GradeResp): VerifyResult {
  switch (resp.badge) {
    case 'verified-strong':
      return { verdict: 'agree', evidence: 'program_verified' }
    case 'verified-weak':
      return { verdict: 'agree', evidence: 'model_review' }
    case 'disagree':
      return { verdict: 'disagree', evidence: evidenceOf(resp.evidence_type) }
    case 'out-of-scope':
      return {
        verdict: 'out_of_scope',
        evidence: evidenceOf(resp.evidence_type),
        outOfScope: { detected: resp.out_of_scope_kp || undefined },
      }
    default:
      return { verdict: 'unverifiable', evidence: 'model_review' }
  }
}
