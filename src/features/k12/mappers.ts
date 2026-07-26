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
      // 独立保留学科（M1 学期汇总分科计数用；schema 未声明该字段，不参与行渲染）
      subject: subj,
      // 复习队列可混入积累本纠错项；动作层据此区分验算变式与原词重现。
      review_kind: dto.review_kind,
      // 抽查复验（§3.6）：仅 failed 在详情呈现「家长确认（复验未过）」事实标注；
      // scheduled 不呈现（不打抽查标签，规则 1）。schema 未声明该字段，不参与行渲染。
      spot_check_state: dto.spot_check_state,
      parent_confirmed_at: dto.parent_confirmed_at,
      archived_reason: dto.archived_reason,
      archived_at: dto.archived_at,
      archive_restored_at: dto.archive_restored_at,
      restorable: dto.restorable === true,
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
  // review-queue 是跨 collection 的统一队列，可能含 /mistakes 不会返回的语英积累纠错项。
  // 先按 record_id 合并：同 ID 用 queue 补 subject/review_kind，queue 独有项追加到 items，
  // 否则通用 RecordList 会因找不到 ID 而静默丢掉这条到期记录。
  const dueById = new Map(due.map((d) => [d.record_id, d]))
  const merged = all.map((d) => {
    const queued = dueById.get(d.record_id)
    return queued
      ? {
          ...d,
          subject: d.subject ?? queued.subject,
          review_kind: d.review_kind ?? queued.review_kind,
        }
      : d
  })
  const allIDs = new Set(all.map((d) => d.record_id))
  for (const queued of due) if (!allIDs.has(queued.record_id)) merged.push(queued)

  const items = merged.map((d) => mistakeToRecord(d, agentId))
  const statusCounts: Record<string, number> = {}
  for (const it of items)
    if (it.status) statusCounts[it.status] = (statusCounts[it.status] ?? 0) + 1
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
    fields: {
      subject: dto.subject,
      entry_type: dto.entry_type,
      content: dto.content,
      source: dto.source ?? '',
      created_at: dto.created_at ? String(dto.created_at) : '',
      dictation_generation: dto.dictation_generation,
    },
    version: dto.version,
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
  // out_of_scope 是后端的业务真值；兼容曾返回 badge=unverifiable 的旧响应。
  if (resp.out_of_scope) {
    return {
      verdict: 'out_of_scope',
      evidence: evidenceOf(resp.evidence_type),
      outOfScope: { detected: resp.out_of_scope_kp || undefined },
    }
  }
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

/**
 * UI/store 使用的完整批改结果。recordCreated 为既有调用方的“已在错题本”语义；
 * recordNewlyCreated 精确保留 wire record_created，二者共同区分新建、去重命中和未入本。
 */
export interface GradeViewResult {
  verify: VerifyResult
  solution: string
  /** 批改判定五值口径（agree=答对/disagree=答错；布尔 correct 已随后端契约删除）。 */
  verdict: GradeResp['verdict']
  evidenceType: GradeResp['evidence_type']
  badge: GradeResp['badge']
  wrongStep?: string
  errorCause?: string
  outOfScope: boolean
  outOfScopeKnowledgePoint?: string
  recordCreated: boolean
  recordNewlyCreated: boolean
  recordDeduplicated: boolean
  recordId?: string
}

/** grade wire DTO → 不丢字段的 store/view 契约。 */
export function gradeToResult(resp: GradeResp): GradeViewResult {
  const recorded = Boolean(resp.record_id)
  return {
    verify: gradeToVerify(resp),
    solution: resp.solution,
    verdict: resp.verdict,
    evidenceType: resp.evidence_type,
    badge: resp.badge,
    wrongStep: resp.wrong_step,
    errorCause: resp.error_cause,
    outOfScope: resp.out_of_scope,
    outOfScopeKnowledgePoint: resp.out_of_scope_kp,
    // 兼容 RecognizeGuardPanel 等既有调用：去重命中已有 record_id 也应显示“已入本”。
    recordCreated: resp.record_created || recorded,
    recordNewlyCreated: resp.record_created,
    recordDeduplicated: !resp.record_created && recorded,
    recordId: resp.record_id,
  }
}
